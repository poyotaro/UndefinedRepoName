// ランキングの通し確認（プロトコル v2）：ワールドと同じ符号で記録と名前を送り、集計（tools/update.mjs）が読む差分を表示する。
// 使い方：node test/sim.mjs [サーバーの URL（既定 http://127.0.0.1:8799）]
//   続けて：RANKING_URL=http://127.0.0.1:8799 RANKING_KEY=localkey node tools/update.mjs <出力先>
import { encodeRecord, encodeName, decodeRecord, decodeName } from "../src/codec.js";

const base = process.argv[2] || "http://127.0.0.1:8799";
async function send(words, image, ip) {
  for (const n of words) {
    const r = await fetch(base + "/2/" + n, { headers: { accept: image ? "image/png" : "text/plain", "cf-connecting-ip": ip } });
    await r.arrayBuffer();
  }
}
const record = (ip, r) => send(encodeRecord(r), false, ip);
const name = (ip, rid, s) => send(encodeName(rid, s), true, ip);

// 符号の往復
const sample = { rid: 123456789, opp: 987654321, kind: 1, ranked: 1, result: 2, mid: 13 };
const back = decodeRecord(encodeRecord(sample));
if (JSON.stringify(back) !== JSON.stringify(sample)) throw new Error("record roundtrip " + JSON.stringify(back));
if (decodeName(encodeName(5, "ぽよ\tたろう")).name !== "ぽよ たろう") throw new Error("name roundtrip");
const broken = encodeRecord(sample); broken[3] ^= 1;
if (decodeRecord(broken) !== null) throw new Error("check bits");
console.log("codec ok (" + encodeRecord(sample).length + " words per record, " + encodeName(1, "poyotaro").length + " per 8-char name)");

const A = 123456789, B = 987654321, C = 555;
await name("10.0.0.1", A, "ぽよたろう");
await name("10.0.0.2", B, "Rival");
for (let m = 1; m <= 3; m++) {                               // 9 ボールのランク戦 3 回（A 勝ち）。2 人がそれぞれ自分の分を送る
  await record("10.0.0.1", { rid: A, opp: B, kind: 0, ranked: 1, result: 1, mid: m });
  await record("10.0.0.2", { rid: B, opp: A, kind: 0, ranked: 1, result: 0, mid: m });
}
await record("10.0.0.2", { rid: B, opp: A, kind: 1, ranked: 1, result: 1, mid: 4 });   // 10 ボール：B だけが送った（10 分待ってから半分の重み）
await record("10.0.0.3", { rid: C, opp: 0, kind: 3, ranked: 0, result: 1, mid: 5 });   // スヌーカーのダブルス（相手なし）
// 同じ IP から 2 人分の断片が混ざる（同じ家）：検査で捨てられる
const w1 = encodeRecord({ rid: A, opp: B, kind: 2, ranked: 1, result: 1, mid: 6 }), w2 = encodeRecord({ rid: B, opp: A, kind: 2, ranked: 1, result: 0, mid: 6 });
for (let i = 0; i < w1.length; i++) { await send([w1[i]], false, "10.0.0.9"); await send([w2[i]], false, "10.0.0.9"); }
const d = await (await fetch(base + "/delta.txt?key=localkey&since=0,0")).text();
console.log(d);
if ((await fetch(base + "/delta.txt?key=wrong")).status !== 403) throw new Error("key");
