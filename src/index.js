// PoyoPoyo Billiards のランキングの受け口（プロトコル v3、2026-10-14。仕様は docs/protocol-v3.md。v2 は docs/protocol.md）。
//   VRChat の Udon は読み込みしかできないので、ワールドが用意した 4096 本の URL（/3/0〜/3/4095）の「どれを読むか」で 11bit ずつ送る。
//   v3：ID はサーバーが配る（登録簿 players）。文字列の経路 = 登録（返事で ID を返す）と名前、画像の経路 = 試合の記録。
//   v2（/2/、古いワールド）も当分受け取り、ID（uid の下 30bit）を登録簿で新しい ID に読み替える。
//   断片は 1 つの Durable Object（Assembler）のメモリで組み立て、できあがった記録（試合 1 件・名前 1 件）だけを保存する（無料枠の書き込みを節約）。
//   集計（組み合わせ・レーティング・順位）は GitHub Actions（tools/update.mjs）が GET /delta.txt で新しい記録だけを読んで行う。
//   旧形式（/0〜/4095、v1）は受け取るだけで捨てる（古いワールドの送信）。
import { DurableObject } from "cloudflare:workers";
import { RecordWords, StartFlag, WordBits, nameWordCount, decodeRecord, decodeName,
  stringFrameWords, recordFrameWords, decodeRegister, decodeName3, decodeRecord3, rid30OfUid, tagOfUid } from "./codec.js";

const Png1x1 = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
), c => c.charCodeAt(0));
const noStore = { "Cache-Control": "no-store, max-age=0" };
const FrameTimeoutMs = 3 * 60 * 1000;     // 断片の間がこれより空いたら組み立て中のフレームを捨てる
const KeepMs = 24 * 3600 * 1000;          // 集計が読んだ記録を消すまでの時間
const GitHubRepo = "poyotaro/UndefinedRepoName";   // 集計（.github/workflows/export.yml）のあるリポジトリ
const DeltaLimit = 5000;
const NewIdsPerDay = 20;                  // 1 つの IP（ハッシュ）から 1 日に新しく作れる ID の数
// v2 からの移行（2026-10-14）：v2 の ID（rid30）に先に割り当てる新しい ID。その人が v3 で登録すると、uid の下 30bit で同じ行になる
const LegacyPlayers = [[1, 410606822], [2, 89809756], [3, 237702707]];

function assembler(env) { return env.ASM.get(env.ASM.idFromName("main")); }

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") return new Response("method", { status: 405 });
    const url = new URL(request.url);
    const path = url.pathname.slice(1);
    const m = /^([23])\/(\d{1,4})$/.exec(path);
    if (m || /^\d{1,4}$/.test(path)) {
      const image = (request.headers.get("accept") || "").includes("image/");
      const ver = m ? Number(m[1]) : 1;
      const n = m ? Number(m[2]) : -1;
      const ip = request.headers.get("cf-connecting-ip") || "?";
      let text = "ok";
      if (m && n < 4096) {
        const p = assembler(env).push(ip, ver, image ? 1 : 0, n, Date.now());
        // v3 の文字列の経路（登録・名前）は返事を待つ（登録の最後の語の返事が ID）。ほかは待たない
        if (ver === 3 && !image) text = await p.catch(e => { console.log("push", e); return "bad"; });
        else ctx.waitUntil(p.catch(e => console.log("push", e)));
      }
      if (image) return new Response(Png1x1, { headers: { ...noStore, "Content-Type": "image/png" } });
      return new Response(text, { headers: { ...noStore, "Content-Type": "text/plain" } });
    }
    if (path === "delta.txt") {
      if (!env.EXPORT_KEY || url.searchParams.get("key") !== env.EXPORT_KEY) return new Response("forbidden", { status: 403 });
      const since = (url.searchParams.get("since") || "0,0").split(",").map(Number);
      const text = await assembler(env).delta(since[0] || 0, since[1] || 0, Date.now());
      return new Response(text, { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },

  /// 毎時 0・15・30・45 分に集計（GitHub Actions の export-ranking）を起動する（2026-10-14）。
  ///   GitHub の schedule は 5〜25 分遅れるので、ワールドの板が更新の時刻を数えられるように、起動はこちらで決める。
  ///   GitHub 側の schedule は予備として残す（このトークンが切れても集計は止まらない）
  async scheduled(controller, env, ctx) {
    console.log("cron", controller.cron, new Date(controller.scheduledTime).toISOString(), "now", new Date().toISOString());
    // 起動するのは 15 分の区切りから 1 分以内の予定だけ（Cron の式を試しに細かくしても集計は増えない）。
    //   予定の時刻が区切りから数十秒ずれることがある（2026-10-14 は 59 秒）ので、1 分の幅をとる
    if (controller.scheduledTime % (15 * 60 * 1000) >= 60 * 1000) return;
    if (!env.GH_DISPATCH_TOKEN) { console.log("dispatch: no token"); return; }
    // 前回の起動の後に新しい記録・名前が来ていなければ起動しない（GitHub Actions の実行を減らす。v3）
    const asm = assembler(env);
    const mark = await asm.newSince();
    if (!mark) return;
    const res = await fetch(`https://api.github.com/repos/${GitHubRepo}/actions/workflows/export.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.GH_DISPATCH_TOKEN,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "poyo-billiards-ranking",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (res.status !== 204) { console.log("dispatch", res.status, await res.text()); return; }
    await asm.dispatched(mark);
  },
};

/// 断片の組み立てと、できあがった記録の保管（SQLite）。1 つだけ（idFromName("main")）
export class Assembler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.frames = new Map();   // "ip|版|経路" → { need, words, ts }
    this.pushes = 0;
    this.newIds = new Map();   // IP のハッシュ → { day, n }（新しい ID の作りすぎの防止。メモリだけ）
    this.sql = ctx.storage.sql;
    // seq（INTEGER PRIMARY KEY）の順に読むので、ほかの索引は作らない（書き込みの行数を増やさない）
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, rid INTEGER NOT NULL, opp INTEGER NOT NULL,
      kind INTEGER NOT NULL, ranked INTEGER NOT NULL, result INTEGER NOT NULL, mid INTEGER NOT NULL, src TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS names (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, rid INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE, rid30 INTEGER NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS players_rid30 ON players (rid30);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);`);
    // 登録簿（v3）は消さない。AUTOINCREMENT なので ID を振り直さない。空の時だけ v2 からの移行の行を入れる
    if (this.sql.exec("SELECT COUNT(*) AS n FROM players").one().n === 0)
      for (const [id, rid30] of LegacyPlayers) this.sql.exec("INSERT INTO players (id, uid, rid30, ts) VALUES (?, NULL, ?, ?)", id, rid30, Date.now());
  }

  /// 11bit の断片を 1 つ受け取る。返事（v3 の文字列の経路だけ使う）：フレームの途中は "ok"、登録ができたら "id\t<ID>"、だめなら "bad"
  ///   v2：経路 0 = 文字列 = 試合の記録、1 = 画像 = 名前。v3：経路 0 = 文字列 = 登録・名前、1 = 画像 = 試合の記録
  async push(ip, ver, ch, n, now) {
    const key = ip + "|" + ver + "|" + ch;
    if (++this.pushes % 1000 === 0) for (const [k, f] of this.frames) if (now - f.ts > FrameTimeoutMs) this.frames.delete(k);
    const payload = n & (StartFlag - 1);
    let f;
    if (n >= StartFlag) {
      const need = ver === 3 ? (ch === 0 ? stringFrameWords(payload) : recordFrameWords(payload))
        : (ch === 0 ? RecordWords : nameWordCount(payload >> (WordBits - 5)));
      f = { need, words: [payload], ts: now };
      this.frames.set(key, f);
    } else {
      f = this.frames.get(key);
      if (!f || now - f.ts > FrameTimeoutMs) return "bad";
      f.words.push(payload);
      f.ts = now;
    }
    if (f.words.length < f.need) return "ok";
    this.frames.delete(key);
    if (ver === 3 && ch === 0) {
      if ((f.words[0] >> 10) === 0) {
        const r = decodeRegister(f.words);
        if (!r) return "bad";
        const id = await this.register(r.uid, ip, now);
        return id > 0 ? "id\t" + id : "bad";
      }
      const r = decodeName3(f.words);
      if (!r) return "bad";
      const row = this.sql.exec("SELECT uid FROM players WHERE id = ?", r.id).toArray()[0];
      if (!row || !row.uid || tagOfUid(row.uid) !== r.tag) return "bad";   // 合言葉（uid の先頭 24bit）が合わない
      this.sql.exec("INSERT INTO names (ts, rid, name) VALUES (?, ?, ?)", now, r.id, r.name);
      return "ok";
    }
    if (ver === 3) {
      const r = decodeRecord3(f.words);
      if (!r || !this.known(r.rid) || (r.opp !== 0 && !this.known(r.opp))) return "bad";
      await this.insertRecord(r, ip, now);
      return "ok";
    }
    // v2（古いワールド）：ID（rid30）を登録簿で読み替える
    if (ch === 0) {
      const r = decodeRecord(f.words);
      if (!r) return "bad";
      r.rid = this.idOfRid30(r.rid, now);
      r.opp = r.opp === 0 ? 0 : this.idOfRid30(r.opp, now);
      await this.insertRecord(r, ip, now);
    } else {
      const r = decodeName(f.words);
      if (!r) return "bad";
      const id = this.idOfRid30(r.rid, now);
      // v3 で登録済みの人の名前は v2 では変えない（v2 の名前は誰でも送れるので）
      const row = this.sql.exec("SELECT uid FROM players WHERE id = ?", id).one();
      if (!row.uid) this.sql.exec("INSERT INTO names (ts, rid, name) VALUES (?, ?, ?)", now, id, r.name);
    }
    return "ok";
  }

  async insertRecord(r, ip, now) {
    const src = await this.hash(ip);
    this.sql.exec("INSERT INTO records (ts, rid, opp, kind, ranked, result, mid, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      now, r.rid, r.opp, r.kind, r.ranked, r.result, r.mid, src);
  }

  known(id) { return this.sql.exec("SELECT 1 FROM players WHERE id = ?", id).toArray().length > 0; }

  /// 登録（v3）：同じ uid には同じ ID。初めての uid は、uid の下 30bit が同じで uid の空いた行（v2 からの移行・古いワールドの送信）があればそれを、無ければ新しい ID
  async register(uid, ip, now) {
    const row = this.sql.exec("SELECT id FROM players WHERE uid = ?", uid).toArray()[0];
    if (row) return row.id;
    const rid30 = rid30OfUid(uid);
    const free = this.sql.exec("SELECT id FROM players WHERE rid30 = ? AND uid IS NULL ORDER BY id LIMIT 1", rid30).toArray()[0];
    if (free) {
      this.sql.exec("UPDATE players SET uid = ? WHERE id = ?", uid, free.id);
      return free.id;
    }
    const h = await this.hash(ip);
    const day = Math.floor(now / 86400000);
    const c = this.newIds.get(h);
    if (c && c.day === day && c.n >= NewIdsPerDay) return 0;
    this.newIds.set(h, { day, n: c && c.day === day ? c.n + 1 : 1 });
    return this.sql.exec("INSERT INTO players (uid, rid30, ts) VALUES (?, ?, ?) RETURNING id", uid, rid30, now).one().id;
  }

  /// v2 の ID（rid30）→ 新しい ID。無ければ uid の空いた行を作る（後で v3 で登録すると同じ行になる）
  idOfRid30(rid30, now) {
    const row = this.sql.exec("SELECT id FROM players WHERE rid30 = ? ORDER BY id LIMIT 1", rid30).toArray()[0];
    if (row) return row.id;
    return this.sql.exec("INSERT INTO players (uid, rid30, ts) VALUES (NULL, ?, ?) RETURNING id", rid30, now).one().id;
  }

  /// 集計の起動（Cron）用：前回の起動の後に新しい記録・名前があれば、その印（記録と名前の最大の seq）を返す。無ければ null
  async newSince() {
    const rec = this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM records").one().m;
    const nam = this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM names").one().m;
    const kv = new Map(this.sql.exec("SELECT k, v FROM kv").toArray().map(r => [r.k, r.v]));
    if (rec === (kv.get("dispRec") ?? -1) && nam === (kv.get("dispName") ?? -1)) return null;
    return { rec, nam };
  }
  async dispatched(mark) {
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('dispRec', ?), ('dispName', ?)", mark.rec, mark.nam);
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
