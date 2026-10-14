// PoyoPoyo Billiards のランキングの受け口（プロトコル v2、2026-10-12。仕様は docs/protocol.md）。
//   VRChat の Udon は読み込みしかできないので、ワールドが用意した 4096 本の URL（/2/0〜/2/4095）の「どれを読むか」で 11bit ずつ送る。
//   断片は 1 つの Durable Object（Assembler）のメモリで組み立て、できあがった記録（試合 1 件・名前 1 件）だけを保存する（無料枠の書き込みを節約）。
//   集計（組み合わせ・レーティング・順位）は GitHub Actions（tools/update.mjs）が GET /delta.txt で新しい記録だけを読んで行う。
//   旧形式（/0〜/4095、v1）は受け取るだけで捨てる（古いワールドの送信）。
import { DurableObject } from "cloudflare:workers";
import { RecordWords, StartFlag, WordBits, nameWordCount, decodeRecord, decodeName } from "./codec.js";

const Png1x1 = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
), c => c.charCodeAt(0));
const noStore = { "Cache-Control": "no-store, max-age=0" };
const FrameTimeoutMs = 3 * 60 * 1000;     // 断片の間がこれより空いたら組み立て中のフレームを捨てる
const KeepMs = 24 * 3600 * 1000;          // 集計が読んだ記録を消すまでの時間
const DeltaLimit = 5000;

function assembler(env) { return env.ASM.get(env.ASM.idFromName("main")); }

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") return new Response("method", { status: 405 });
    const url = new URL(request.url);
    const path = url.pathname.slice(1);
    const m = /^2\/(\d{1,4})$/.exec(path);
    if (m || /^\d{1,4}$/.test(path)) {
      const image = (request.headers.get("accept") || "").includes("image/");
      const n = m ? Number(m[1]) : -1;
      if (m && n < 4096) ctx.waitUntil(assembler(env).push(request.headers.get("cf-connecting-ip") || "?", image ? 1 : 0, n, Date.now()).catch(e => console.log("push", e)));
      if (image) return new Response(Png1x1, { headers: { ...noStore, "Content-Type": "image/png" } });
      return new Response("ok", { headers: { ...noStore, "Content-Type": "text/plain" } });
    }
    if (path === "delta.txt") {
      if (!env.EXPORT_KEY || url.searchParams.get("key") !== env.EXPORT_KEY) return new Response("forbidden", { status: 403 });
      const since = (url.searchParams.get("since") || "0,0").split(",").map(Number);
      const text = await assembler(env).delta(since[0] || 0, since[1] || 0, Date.now());
      return new Response(text, { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
};

/// 断片の組み立てと、できあがった記録の保管（SQLite）。1 つだけ（idFromName("main")）
export class Assembler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.frames = new Map();   // "ip|経路" → { need, words, ts }
    this.pushes = 0;
    this.sql = ctx.storage.sql;
    // seq（INTEGER PRIMARY KEY）の順に読むので、ほかの索引は作らない（書き込みの行数を増やさない）
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, rid INTEGER NOT NULL, opp INTEGER NOT NULL,
      kind INTEGER NOT NULL, ranked INTEGER NOT NULL, result INTEGER NOT NULL, mid INTEGER NOT NULL, src TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS names (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, rid INTEGER NOT NULL, name TEXT NOT NULL);`);
  }

  /// 11bit の断片を 1 つ受け取る（経路 0 = 文字列 = 試合の記録、1 = 画像 = 名前）
  async push(ip, ch, n, now) {
    const key = ip + "|" + ch;
    if (++this.pushes % 1000 === 0) for (const [k, f] of this.frames) if (now - f.ts > FrameTimeoutMs) this.frames.delete(k);
    const payload = n & (StartFlag - 1);
    let f;
    if (n >= StartFlag) {
      const need = ch === 0 ? RecordWords : nameWordCount(payload >> (WordBits - 5));
      f = { need, words: [payload], ts: now };
      this.frames.set(key, f);
    } else {
      f = this.frames.get(key);
      if (!f || now - f.ts > FrameTimeoutMs) return;
      f.words.push(payload);
      f.ts = now;
    }
    if (f.words.length < f.need) return;
    this.frames.delete(key);
    if (ch === 0) {
      const r = decodeRecord(f.words);
      if (!r) return;
      const src = await this.hash(ip);
      this.sql.exec("INSERT INTO records (ts, rid, opp, kind, ranked, result, mid, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        now, r.rid, r.opp, r.kind, r.ranked, r.result, r.mid, src);
    } else {
      const r = decodeName(f.words);
      if (r) this.sql.exec("INSERT INTO names (ts, rid, name) VALUES (?, ?, ?)", now, r.rid, r.name);
    }
  }

  /// 送り元の IP は保存しない。秘密の塩をつけたハッシュの先頭 8 桁（2 人の記録が別の場所から来たかを見るだけ）
  async hash(ip) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((this.env.SALT || "") + ip));
    return [...new Uint8Array(d).slice(0, 4)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  /// 集計（GitHub Actions）用：seq が since より後の記録と名前。呼ばれた since までは集計が保存済みなので、1 日たったら消す
  ///   seq は AUTOINCREMENT ではなく、表が空になると 1 から振り直す。全部消すと次の記録が since 以下の番号になって
  ///   集計に読まれなくなる（2026-10-14 に起きた）ので、いちばん新しい行は残す
  async delta(sinceRec, sinceName, now) {
    if (now - (this.cleaned || 0) > 6 * 3600 * 1000) {   // 掃除は 6 時間に 1 回（読む行数を節約）
      this.cleaned = now;
      this.sql.exec("DELETE FROM records WHERE seq <= ? AND ts < ? AND seq < (SELECT MAX(seq) FROM records)", sinceRec, now - KeepMs);
      this.sql.exec("DELETE FROM names WHERE seq <= ? AND ts < ? AND seq < (SELECT MAX(seq) FROM names)", sinceName, now - KeepMs);
    }
    const recs = this.sql.exec("SELECT * FROM records WHERE seq > ? ORDER BY seq LIMIT ?", sinceRec, DeltaLimit).toArray();
    const names = this.sql.exec("SELECT * FROM names WHERE seq > ? ORDER BY seq LIMIT ?", sinceName, DeltaLimit).toArray();
    const lastRec = recs.length ? recs[recs.length - 1].seq : sinceRec;
    const lastName = names.length ? names[names.length - 1].seq : sinceName;
    const out = ["d2\t" + now + "\t" + lastRec + "\t" + lastName + "\t" + (recs.length === DeltaLimit || names.length === DeltaLimit ? 1 : 0)];
    for (const r of recs) out.push(["R", r.seq, r.ts, r.rid, r.opp, r.kind, r.ranked, r.result, r.mid, r.src].join("\t"));
    for (const p of names) out.push(["P", p.seq, p.ts, p.rid, p.name].join("\t"));
    return out.join("\n") + "\n";
  }
}
