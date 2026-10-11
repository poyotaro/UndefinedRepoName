// ランキングの通し確認：ワールドと同じ符号化で、2 人のランク戦の報告と名前を送り、集計を読む。
// 使い方：node test/sim.mjs [サーバーの URL（既定 http://127.0.0.1:8799）]
const base = process.argv[2] || "http://127.0.0.1:8799";

function words(value, count) {          // 大きい桁から 10bit ずつ
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(Math.floor(value / Math.pow(1024, i)) % 1024);
  return out;
}
function halfA(matchId, result, kind, ranked) { return words(matchId * 64 + result * 16 + kind * 2 + ranked, 3); }
function halfB(rid) { return words(rid, 3); }
function nameWords(rid, name) {
  const bits = [];
  for (let i = 29; i >= 0; i--) bits.push((rid >> i) & 1);
  for (const ch of name) { const c = ch.charCodeAt(0); for (let i = 15; i >= 0; i--) bits.push((c >> i) & 1); }
  while (bits.length % 10) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 10) out.push(parseInt(bits.slice(i, i + 10).join(""), 2));
  return out;
}
async function send(n, image, ip) {
  const r = await fetch(base + "/" + n, { headers: { accept: image ? "image/png" : "text/plain", "cf-connecting-ip": ip } });
  await r.arrayBuffer();
}
async function frame(head, ws, image, ip) {
  await send(head * 1024 + ws[0], image, ip);
  for (let i = 1; i < ws.length; i++) await send(2 * 1024 + ws[i], image, ip);
}
async function report(ip, matchId, rid, result, kind, ranked) {
  // 文字列の経路に A、画像の経路に B（実際は並行。ここでは順に）
  await frame(3, halfA(matchId, result, kind, ranked), false, ip);
  await frame(3, halfB(rid), true, ip);
}
async function name(ip, rid, s) {
  await send(1 * 1024 + s.length, false, ip);
  for (const w of nameWords(rid, s)) await send(2 * 1024 + w, false, ip);
}

const A = 123456789, B = 987654321;
await name("10.0.0.1", A, "ぽよたろう");
await name("10.0.0.2", B, "Rival");
for (let m = 1; m <= 3; m++) {
  const matchId = 5000000 + m;
  await report("10.0.0.1", matchId, A, 1, 0, 1);   // A の端末：A 勝ち
  await report("10.0.0.1", matchId, B, 0, 0, 1);   //         ：B の分も代わりに
  await report("10.0.0.2", matchId, B, 0, 0, 1);   // B の端末：B 負け（重複は無視される）
}
await report("10.0.0.3", 6000001, A, 1, 3, 0);     // スヌーカーの普通の試合（スタッツだけ）
const text = await (await fetch(base + "/export.txt")).text();
console.log(text);
