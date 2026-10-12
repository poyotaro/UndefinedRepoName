// ランキングのプロトコルと集計（index.js から使う。テストからも読む）。仕様は docs/protocol.md
export const Png1x1 = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
), c => c.charCodeAt(0));

export const HeadReport = 3, HeadMore = 2, HeadName = 1;
export const ReportWords = 3;           // 報告の半分は 30bit
export const MaxNameChars = 32;
export const BaseRating = 1500, BaseK = 32;
// レーティングの単位は種目（2026-10-12 ユーザー指定：9・10・8 ボールは別のランキング）。ratings.family には種目の番号を入れる（列の名前は昔のまま）。
// その他（6）は順位なし
const FamilyOfKind = [0, 1, 2, 3, 4, 5, -1];
// 書き出し v1（古いワールドの板）の 4 列：プール→9 ボール、スヌーカー、ピラミッド、キャロム→3 クッション
const V1Families = [0, 3, 4, 5];
const PairWindowMs = 3 * 3600 * 1000;          // 同じ試合番号の報告とみなす時間
const HalfWindowMs = 60 * 1000;                // A と B を組む時間

const noStore = { "Cache-Control": "no-store, max-age=0" };

/// 10bit の語の並び（大きい桁から）を数にする
export function wordsToBits(words) {
  let bits = [];
  for (const w of words) for (let i = 9; i >= 0; i--) bits.push((w >> i) & 1);
  return bits;
}
export function readBits(bits, from, count) {
  let v = 0;
  for (let i = 0; i < count; i++) v = v * 2 + (bits[from + i] || 0);
  return v;
}
export function nameWords(len) { return Math.ceil((30 + 16 * len) / 10); }

/// 半分 A の 30bit：試合番号 24・結果 2（0 負け・1 勝ち・2 引き分け）・種目 3・ランク戦 1
export function decodeHalfA(words) {
  const b = wordsToBits(words);
  return { matchId: readBits(b, 0, 24), result: readBits(b, 24, 2), kind: readBits(b, 26, 3), ranked: readBits(b, 29, 1) };
}
export function decodeName(words, len) {
  const b = wordsToBits(words);
  const rid = readBits(b, 0, 30);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(readBits(b, 30 + 16 * i, 16));
  return { rid, name: s.replace(/[\t\r\n]/g, " ").trim() };
}

export function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }

/// 12bit の断片を 1 つ受け取る
export async function receive(env, ip, ch, n, now) {
  const head = n >> 10, payload = n & 1023;
  const db = env.DB;
  if (head === HeadReport) {
    await putFrame(db, ip, ch, HeadReport, ReportWords, [payload], now);
    return;
  }
  if (head === HeadName) {
    const len = Math.min(payload, MaxNameChars);
    await putFrame(db, ip, ch, HeadName, nameWords(len), [len], now);
    return;
  }
  if (head !== HeadMore) return;
  const f = await db.prepare("SELECT kind, need, words, ts FROM frames WHERE ip = ? AND ch = ?").bind(ip, ch).first();
  if (!f || now - f.ts > 60 * 1000) return;
  const words = JSON.parse(f.words);
  words.push(payload);
  const body = f.kind === HeadName ? words.slice(1) : words;
  if (body.length < f.need) {
    await db.prepare("UPDATE frames SET words = ?, ts = ? WHERE ip = ? AND ch = ?").bind(JSON.stringify(words), now, ip, ch).run();
    return;
  }
  await db.prepare("DELETE FROM frames WHERE ip = ? AND ch = ?").bind(ip, ch).run();
  if (f.kind === HeadName) {
    const { rid, name } = decodeName(body, words[0]);
    if (rid > 0 && name.length > 0)
      await db.prepare("INSERT INTO players (rid, name, ts) VALUES (?, ?, ?) ON CONFLICT(rid) DO UPDATE SET name = excluded.name, ts = excluded.ts").bind(rid, name, now).run();
    return;
  }
  // 報告の半分：経路 0（文字列）が A、経路 1（画像）が B
  if (ch === 0) {
    const a = decodeHalfA(body);
    if (a.matchId === 0 || a.result > 2) return;
    await db.prepare("INSERT INTO halves (ip, part, a, b, ts) VALUES (?, 'A', ?, ?, ?)").bind(ip, a.matchId, a.result * 16 + a.kind * 2 + a.ranked, now).run();
  } else {
    const rid = readBits(wordsToBits(body), 0, 30);
    if (rid === 0) return;
    await db.prepare("INSERT INTO halves (ip, part, a, b, ts) VALUES (?, 'B', ?, 0, ?)").bind(ip, rid, now).run();
  }
  await joinHalves(env, ip, now);
}

async function putFrame(db, ip, ch, kind, need, words, now) {
  await db.prepare("INSERT INTO frames (ip, ch, kind, need, words, ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ip, ch) DO UPDATE SET kind = excluded.kind, need = excluded.need, words = excluded.words, ts = excluded.ts")
    .bind(ip, ch, kind, need, JSON.stringify(words), now).run();
}

/// 同じ IP の、まだ組んでいない A と B を古い順に組んで、試合の報告にする
async function joinHalves(env, ip, now) {
  const db = env.DB;
  for (;;) {
    const a = await db.prepare("SELECT id, a, b, ts FROM halves WHERE ip = ? AND part = 'A' AND used = 0 AND ts > ? ORDER BY id LIMIT 1").bind(ip, now - HalfWindowMs).first();
    const b = await db.prepare("SELECT id, a, ts FROM halves WHERE ip = ? AND part = 'B' AND used = 0 AND ts > ? ORDER BY id LIMIT 1").bind(ip, now - HalfWindowMs).first();
    if (!a || !b) return;
    await db.prepare("UPDATE halves SET used = 1 WHERE id IN (?, ?)").bind(a.id, b.id).run();
    const result = a.b >> 4, kind = (a.b >> 1) & 7, ranked = a.b & 1;
    await addReport(env, a.a, b.a, result, kind, ranked, ip, now);
  }
}

/// 試合の報告を 1 つ足す：スタッツを数え、2 人そろったランク戦はレーティングを動かす
export async function addReport(env, matchId, rid, result, kind, ranked, ip, now) {
  const db = env.DB;
  await db.prepare("INSERT OR IGNORE INTO sources (match_id, ip, ts) VALUES (?, ?, ?)").bind(matchId, ip, now).run();
  const ins = await db.prepare("INSERT OR IGNORE INTO reports (match_id, rid, result, kind, ranked, ip, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(matchId, rid, result, kind, ranked, ip, now).run();
  if (!ins.meta.changes) { if (ranked) await tryRate(env, matchId, now, false); return; }
  await db.prepare("INSERT OR IGNORE INTO players (rid, name, ts) VALUES (?, '', ?)").bind(rid, now).run();
  const counted = await db.prepare("INSERT OR IGNORE INTO counted (match_id, rid, ts) VALUES (?, ?, ?)").bind(matchId, rid, now).run();
  if (counted.meta.changes) {
    await db.prepare("INSERT INTO stats (rid, kind, matches, wins) VALUES (?, ?, 1, ?) ON CONFLICT(rid, kind) DO UPDATE SET matches = matches + 1, wins = wins + excluded.wins")
      .bind(rid, kind, result === 1 ? 1 : 0).run();
  }
  if (ranked) await tryRate(env, matchId, now, false);
}

/// 2 人の報告がそろった試合のレーティングを動かす。2 か所（2 つの IP）から届いていればすぐ、1 か所だけなら force（定期の処理）のときに半分の重みで
export async function tryRate(env, matchId, now, force) {
  const db = env.DB;
  const rows = (await db.prepare("SELECT rid, result, ip, ranked, kind FROM reports WHERE match_id = ? AND ts > ?").bind(matchId, now - PairWindowMs).all()).results;
  if (rows.length !== 2) return;
  const [x, y] = rows;
  if (!x.ranked || !y.ranked || x.kind !== y.kind) return;
  const family = FamilyOfKind[x.kind] ?? -1;
  if (family < 0) return;
  const ips = await db.prepare("SELECT COUNT(DISTINCT ip) AS n FROM sources WHERE match_id = ?").bind(matchId).first();
  const single = (ips?.n ?? 0) < 2;
  if (single && !force) return;
  const consistent = (x.result === 1 && y.result === 0) || (x.result === 0 && y.result === 1) || (x.result === 2 && y.result === 2);
  if (!consistent) return;
  const done = await db.prepare("INSERT OR IGNORE INTO rated (match_id, a, b, ts) VALUES (?, ?, ?, ?)").bind(matchId, Math.min(x.rid, y.rid), Math.max(x.rid, y.rid), now).run();
  if (!done.meta.changes) return;
  // 連戦の減衰：同じ 2 人の 24 時間以内のランク戦の数 n で K × 1/(1+0.5n)。1 か所（同じ IP）からだけの報告は半分
  const prior = await db.prepare("SELECT COUNT(*) AS n FROM rated WHERE a = ? AND b = ? AND ts > ? AND match_id != ?")
    .bind(Math.min(x.rid, y.rid), Math.max(x.rid, y.rid), now - 24 * 3600 * 1000, matchId).first();
  let k = BaseK / (1 + 0.5 * (prior?.n ?? 0));
  if (single) k *= 0.5;
  const rx = await rating(db, x.rid, family), ry = await rating(db, y.rid, family);
  const sx = x.result === 1 ? 1 : (x.result === 2 ? 0.5 : 0);
  const ex = expected(rx.rating, ry.rating);
  const dx = k * (sx - ex);
  await db.batch([
    db.prepare("INSERT INTO ratings (rid, family, rating, games) VALUES (?, ?, ?, ?) ON CONFLICT(rid, family) DO UPDATE SET rating = excluded.rating, games = excluded.games").bind(x.rid, family, rx.rating + dx, rx.games + 1),
    db.prepare("INSERT INTO ratings (rid, family, rating, games) VALUES (?, ?, ?, ?) ON CONFLICT(rid, family) DO UPDATE SET rating = excluded.rating, games = excluded.games").bind(y.rid, family, ry.rating - dx, ry.games + 1),
  ]);
}

async function rating(db, rid, family) {
  const r = await db.prepare("SELECT rating, games FROM ratings WHERE rid = ? AND family = ?").bind(rid, family).first();
  return r ? { rating: r.rating, games: r.games } : { rating: BaseRating, games: 0 };
}

/// ワールドが読む集計（タブ区切りの行。docs/protocol.md の「書き出し」）
export async function exportText(env) {
  const db = env.DB;
  const lines = ["v1\t" + Math.floor(Date.now() / 1000)];
  const names = new Map((await db.prepare("SELECT rid, name FROM players").all()).results.map(r => [r.rid, r.name]));
  const nm = rid => (names.get(rid) || "").replace(/[\t\r\n]/g, " ") || ("#" + rid.toString(36));
  for (let f = 0; f < 4; f++) {
    const rows = (await db.prepare("SELECT rid, rating, games FROM ratings WHERE family = ? ORDER BY rating DESC LIMIT 50").bind(V1Families[f]).all()).results;
    rows.forEach((r, i) => lines.push(["F", f, i + 1, r.rid, Math.round(r.rating), r.games, nm(r.rid)].join("\t")));
  }
  const totals = (await db.prepare("SELECT rid, SUM(matches) AS m, SUM(wins) AS w FROM stats GROUP BY rid").all()).results;
  const top = (arr, key, n) => [...arr].sort((a, b) => b[key] - a[key]).slice(0, n);
  top(totals, "m", 50).forEach((r, i) => lines.push(["S", 0, i + 1, r.rid, r.m, nm(r.rid)].join("\t")));
  top(totals, "w", 50).forEach((r, i) => lines.push(["S", 1, i + 1, r.rid, r.w, nm(r.rid)].join("\t")));
  const rated = totals.filter(r => r.m >= 20).map(r => ({ ...r, p: Math.round(1000 * r.w / r.m) }));
  top(rated, "p", 50).forEach((r, i) => lines.push(["S", 2, i + 1, r.rid, r.p, nm(r.rid)].join("\t")));
  return lines.join("\n") + "\n";
}

/// 種目の数（PlayerProgress.Kind*：0 9 ボール・1 10 ボール・2 8 ボール・3 スヌーカー・4 ピラミッド・5 スリークッション。6 その他は順位なし）
export const KindCount = 6;
/// 自分の順位のファイルの分け方（rid % MeShards。ワールドは自分の分だけ読む）
export const MeShards = 64;

/// 書き出し v2（2026-10-12）：種目ごとのランキングと、自分の順位のファイル。GitHub Actions が 1 つの束で受け取って Pages に分けて置く。
///   束の書式：「@@<TAB>パス」の行の後に、そのファイルの中身。docs/protocol.md の「書き出し v2」
export async function exportBundle(env) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const names = new Map((await db.prepare("SELECT rid, name FROM players").all()).results.map(r => [r.rid, r.name]));
  const nm = rid => (names.get(rid) || "").replace(/[\t\r\n]/g, " ") || ("#" + rid.toString(36));
  const top = ["v2\t" + now];
  const me = new Map();   // shard → 行
  const add = (rid, line) => {
    const s = ((rid % MeShards) + MeShards) % MeShards;
    if (!me.has(s)) me.set(s, []);
    me.get(s).push(line);
  };
  for (let k = 0; k < KindCount; k++) {
    const rows = (await db.prepare("SELECT rid, rating, games FROM ratings WHERE family = ? AND games > 0 ORDER BY rating DESC").bind(k).all()).results;
    top.push(["N", k, rows.length].join("\t"));
    rows.forEach((r, i) => {
      if (i < 20) top.push(["R", k, i + 1, r.rid, Math.round(r.rating), r.games, nm(r.rid)].join("\t"));
      add(r.rid, ["M", r.rid, k, i + 1, rows.length, Math.round(r.rating), r.games].join("\t"));
    });
  }
  const totals = (await db.prepare("SELECT rid, SUM(matches) AS m, SUM(wins) AS w FROM stats GROUP BY rid").all()).results;
  const sorted = (arr, key) => [...arr].sort((a, b) => b[key] - a[key]);
  sorted(totals, "m").slice(0, 10).forEach((r, i) => top.push(["S", 0, i + 1, r.rid, r.m, nm(r.rid)].join("\t")));
  sorted(totals, "w").slice(0, 10).forEach((r, i) => top.push(["S", 1, i + 1, r.rid, r.w, nm(r.rid)].join("\t")));
  const rated = totals.filter(r => r.m >= 20).map(r => ({ ...r, p: Math.round(1000 * r.w / r.m) }));
  sorted(rated, "p").slice(0, 10).forEach((r, i) => top.push(["S", 2, i + 1, r.rid, r.p, nm(r.rid)].join("\t")));
  // 自分の通算（試合数・勝利数と、その順位）
  const byM = sorted(totals, "m"), byW = sorted(totals, "w");
  const rankM = new Map(byM.map((r, i) => [r.rid, i + 1])), rankW = new Map(byW.map((r, i) => [r.rid, i + 1]));
  totals.forEach(r => add(r.rid, ["T", r.rid, r.m, r.w, rankM.get(r.rid), rankW.get(r.rid), totals.length].join("\t")));
  const out = ["@@\tdocs/ranking2.txt", ...top];
  for (let s = 0; s < MeShards; s++) {
    out.push("@@\tdocs/me/" + String(s).padStart(2, "0") + ".txt");
    out.push("v2\t" + now);
    for (const line of me.get(s) || []) out.push(line);
  }
  return out.join("\n") + "\n";
}
