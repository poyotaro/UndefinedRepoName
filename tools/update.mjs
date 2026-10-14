// ランキングの集計（プロトコル v2、2026-10-12。GitHub Actions が 15 分ごとに実行。仕様は docs/protocol.md）
//   Worker の /delta.txt から前回より後の記録と名前だけを読み、state/ の表に足して、docs/ の書き出し（ranking2.txt・me/NN.txt）を作り直す。
//   使い方：RANKING_URL=<worker> RANKING_KEY=<鍵> node tools/update.mjs [出力先（既定：リポジトリの根）]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KindCount } from "../src/codec.js";

const Base = (process.env.RANKING_URL || "https://poyo-billiards-ranking.rankingserver.workers.dev").replace(/\/$/, "");
const Key = process.env.RANKING_KEY || "";
const Root = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BaseRating = 1500, BaseK = 32;
const WaitPairMs = Number(process.env.RANKING_WAIT_MS || 10 * 60 * 1000);      // 相手の記録をこれだけ待つ。来なければ 1 人分の記録で数える（レーティングの動きは半分）
const PairWindowMs = 3 * 3600 * 1000;    // 同じ試合の 2 人の記録とみなす時刻の差
const DoneKeepMs = 6 * 3600 * 1000;
const RecentKeepMs = 24 * 3600 * 1000;   // 同じ 2 人の連戦を数える期間
const MeShards = 64, TopN = 20, StatTopN = 10, RateMinMatches = 20;

const sp = (...p) => path.join(Root, ...p);
function readTsv(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(l => l.length > 0).map(l => l.split("\t"));
}
function writeIfChanged(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

// ---- 状態を読む ----
const meta = Object.fromEntries(readTsv(sp("state", "meta.tsv")));
let sinceRec = Number(meta.rec || 0), sinceName = Number(meta.name || 0);
// 読み済みの最後の時刻。サーバーの seq が振り直された時（since を 0 に戻した時）に、読み済みの記録を二重に数えないため
let recTs = Number(meta.recTs || 0), nameTs = Number(meta.nameTs || 0);
const ratings = new Map();   // "rid|kind" → { rating, games }
for (const [rid, k, r, g] of readTsv(sp("state", "ratings.tsv"))) ratings.set(rid + "|" + k, { rating: Number(r), games: Number(g) });
const stats = new Map();     // "rid|kind" → { m, w }
for (const [rid, k, m, w] of readTsv(sp("state", "stats.tsv"))) stats.set(rid + "|" + k, { m: Number(m), w: Number(w) });
const names = new Map(readTsv(sp("state", "names.tsv")).map(([rid, n]) => [Number(rid), n]));
const toRec = c => ({ seq: Number(c[0]), ts: Number(c[1]), rid: Number(c[2]), opp: Number(c[3]), kind: Number(c[4]), ranked: Number(c[5]), result: Number(c[6]), mid: Number(c[7]), src: c[8] });
let pending = readTsv(sp("state", "pending.tsv")).map(toRec);
const done = new Map(readTsv(sp("state", "done.tsv")).map(([k, ts]) => [k, Number(ts)]));
let recent = readTsv(sp("state", "recent.tsv")).map(([a, b, ts]) => ({ a: Number(a), b: Number(b), ts: Number(ts) }));

// ---- 新しい記録を読む ----
let now = Date.now();
for (let loop = 0; loop < 50; loop++) {
  const res = await fetch(`${Base}/delta.txt?key=${encodeURIComponent(Key)}&since=${sinceRec},${sinceName}`);
  if (!res.ok) throw new Error("delta " + res.status);
  const lines = (await res.text()).split("\n").filter(l => l.length > 0).map(l => l.split("\t"));
  const head = lines[0];
  if (!head || head[0] !== "d2") throw new Error("bad delta");
  now = Number(head[1]);
  for (const c of lines.slice(1)) {
    if (c[0] === "R") {
      const r = toRec(c.slice(1));
      if (r.ts <= recTs) continue;
      pending.push(r); recTs = r.ts;
    } else if (c[0] === "P") {
      const ts = Number(c[2]);
      if (ts <= nameTs) continue;
      names.set(Number(c[3]), c.slice(4).join(" ")); nameTs = ts;
    }
  }
  sinceRec = Number(head[2]); sinceName = Number(head[3]);
  if (head[4] !== "1") break;
}

// ---- 組み合わせて数える ----
const keyOf = (rid, opp, mid) => rid + "|" + opp + "|" + mid;
const inverse = r => (r === 2 ? 2 : 1 - r);
function credit(rid, kind, result) {
  const k = rid + "|" + kind;
  const s = stats.get(k) || { m: 0, w: 0 };
  s.m++; if (result === 1) s.w++;
  stats.set(k, s);
}
function rate(x, y, kind, result, half, ts) {   // result は x から見た結果
  if (kind >= KindCount) return;
  const a = Math.min(x, y), b = Math.max(x, y);
  const n = recent.filter(e => e.a === a && e.b === b && e.ts > ts - RecentKeepMs).length;
  let k = BaseK / (1 + 0.5 * n);
  if (half) k *= 0.5;
  const rx = ratings.get(x + "|" + kind) || { rating: BaseRating, games: 0 };
  const ry = ratings.get(y + "|" + kind) || { rating: BaseRating, games: 0 };
  const ex = 1 / (1 + Math.pow(10, (ry.rating - rx.rating) / 400));
  const sx = result === 1 ? 1 : (result === 2 ? 0.5 : 0);
  const d = k * (sx - ex);
  ratings.set(x + "|" + kind, { rating: rx.rating + d, games: rx.games + 1 });
  ratings.set(y + "|" + kind, { rating: ry.rating - d, games: ry.games + 1 });
  recent.push({ a, b, ts });
}
pending.sort((p, q) => p.ts - q.ts || p.seq - q.seq);
const used = new Set();
const keep = [];
let counted = 0;
for (const r of pending) {
  if (used.has(r)) continue;
  const mine = keyOf(r.rid, r.opp, r.mid);
  if (done.has(mine)) { used.add(r); continue; }                 // 同じ記録が 2 回
  if (r.opp === 0) { credit(r.rid, r.kind, r.result); done.set(mine, r.ts); used.add(r); counted++; continue; }
  const theirs = keyOf(r.opp, r.rid, r.mid);
  if (done.has(theirs)) { done.set(mine, r.ts); used.add(r); continue; }   // 相手の記録で数え済み（遅れて届いた）
  const c = pending.find(q => !used.has(q) && q !== r && q.rid === r.opp && q.opp === r.rid && q.mid === r.mid && Math.abs(q.ts - r.ts) < PairWindowMs);
  if (c) {
    used.add(r); used.add(c);
    done.set(mine, r.ts); done.set(theirs, c.ts);
    const consistent = c.kind === r.kind && c.ranked === r.ranked && c.result === inverse(r.result);
    if (!consistent) continue;                                     // 食い違う記録は数えない
    credit(r.rid, r.kind, r.result); credit(c.rid, c.kind, c.result);
    if (r.ranked) rate(r.rid, r.opp, r.kind, r.result, r.src === c.src, Math.max(r.ts, c.ts));
    counted++;
  } else if (now - r.ts > WaitPairMs) {
    used.add(r); done.set(mine, r.ts);
    credit(r.rid, r.kind, r.result); credit(r.opp, r.kind, inverse(r.result));
    if (r.ranked) rate(r.rid, r.opp, r.kind, r.result, true, r.ts);
    counted++;
  } else keep.push(r);
}
pending = keep;
for (const [k, ts] of done) if (ts < now - DoneKeepMs) done.delete(k);
recent = recent.filter(e => e.ts > now - RecentKeepMs);

// ---- 状態を書く ----
const sortKeys = m => [...m.keys()].sort((p, q) => { const [a1, b1] = p.split("|").map(Number), [a2, b2] = q.split("|").map(Number); return a1 - a2 || b1 - b2; });
const tsv = rows => rows.map(r => r.join("\t")).join("\n") + (rows.length ? "\n" : "");
writeIfChanged(sp("state", "ratings.tsv"), tsv(sortKeys(ratings).map(k => [...k.split("|"), ratings.get(k).rating.toFixed(2), ratings.get(k).games])));
writeIfChanged(sp("state", "stats.tsv"), tsv(sortKeys(stats).map(k => [...k.split("|"), stats.get(k).m, stats.get(k).w])));
writeIfChanged(sp("state", "names.tsv"), tsv([...names.keys()].sort((a, b) => a - b).map(r => [r, names.get(r)])));
writeIfChanged(sp("state", "pending.tsv"), tsv(pending.map(r => [r.seq, r.ts, r.rid, r.opp, r.kind, r.ranked, r.result, r.mid, r.src])));
writeIfChanged(sp("state", "done.tsv"), tsv([...done.entries()]));
writeIfChanged(sp("state", "recent.tsv"), tsv(recent.map(e => [e.a, e.b, e.ts])));
writeIfChanged(sp("state", "meta.tsv"), tsv([["rec", sinceRec], ["name", sinceName], ["recTs", recTs], ["nameTs", nameTs]]));

// ---- 書き出し ----
const nm = rid => names.get(rid) || ("#" + rid.toString(36));
const body = [];
const shard = new Map();   // shard → 行
const add = (rid, line) => { const s = rid % MeShards; if (!shard.has(s)) shard.set(s, []); shard.get(s).push({ rid, line }); };
for (let k = 0; k < KindCount; k++) {
  const rows = [];
  for (const [key, v] of ratings) { const [rid, kind] = key.split("|").map(Number); if (kind === k && v.games > 0) rows.push({ rid, ...v }); }
  rows.sort((p, q) => q.rating - p.rating || q.games - p.games || p.rid - q.rid);
  body.push(["N", k, rows.length].join("\t"));
  rows.forEach((r, i) => {
    if (i < TopN) body.push(["R", k, i + 1, r.rid, Math.round(r.rating), r.games, nm(r.rid)].join("\t"));
    add(r.rid, ["M", r.rid, k, i + 1, rows.length, Math.round(r.rating), r.games].join("\t"));
  });
}
const totals = new Map();
for (const [key, v] of stats) { const rid = Number(key.split("|")[0]); const t = totals.get(rid) || { rid, m: 0, w: 0 }; t.m += v.m; t.w += v.w; totals.set(rid, t); }
const all = [...totals.values()];
const byM = [...all].sort((p, q) => q.m - p.m || p.rid - q.rid), byW = [...all].sort((p, q) => q.w - p.w || p.rid - q.rid);
byM.slice(0, StatTopN).forEach((r, i) => body.push(["S", 0, i + 1, r.rid, r.m, nm(r.rid)].join("\t")));
byW.slice(0, StatTopN).forEach((r, i) => body.push(["S", 1, i + 1, r.rid, r.w, nm(r.rid)].join("\t")));
all.filter(r => r.m >= RateMinMatches).map(r => ({ ...r, p: Math.round(1000 * r.w / r.m) })).sort((p, q) => q.p - p.p || p.rid - q.rid)
  .slice(0, StatTopN).forEach((r, i) => body.push(["S", 2, i + 1, r.rid, r.p, nm(r.rid)].join("\t")));
const rankM = new Map(byM.map((r, i) => [r.rid, i + 1])), rankW = new Map(byW.map((r, i) => [r.rid, i + 1]));
for (const r of all) add(r.rid, ["T", r.rid, r.m, r.w, rankM.get(r.rid), rankW.get(r.rid), all.length].join("\t"));
for (const [rid, n] of names) add(rid, ["P", rid, n].join("\t"));

let shardsChanged = 0;
for (let s = 0; s < MeShards; s++) {
  const lines = (shard.get(s) || []).sort((p, q) => p.rid - q.rid).map(e => e.line);
  if (writeIfChanged(sp("docs", "me", String(s).padStart(2, "0") + ".txt"), ["v2", ...lines].join("\n") + "\n")) shardsChanged++;
}
// ranking2.txt は中身か、だれかの順位のファイル（me/NN.txt）が変わった時だけ書く（先頭の時刻の行だけの変化では書かない）。
//   板は先頭の時刻が変わった時に自分のファイルを読み直すので、上位に載らない人の順位だけが変わった時も時刻を進める（2026-10-14）
const rankFile = sp("docs", "ranking2.txt");
const oldBody = fs.existsSync(rankFile) ? fs.readFileSync(rankFile, "utf8").split("\n").slice(1).join("\n") : null;
const newBody = body.join("\n") + "\n";
if (oldBody !== newBody || shardsChanged > 0) writeIfChanged(rankFile, "v2\t" + Math.floor(now / 1000) + "\n" + newBody);
console.log(`records ${counted} counted, ${pending.length} waiting; players ${all.length}; names ${names.size}; ranking ${oldBody !== newBody ? "updated" : "same"}; shards changed ${shardsChanged}`);
