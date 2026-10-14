// プロトコル v3 の通し確認（2026-10-14）：登録・名前・試合の記録と、古いワールド（v2）の送信の読み替え。仕様は docs/protocol-v3.md
// 使い方：npx wrangler dev --port 8799 --var EXPORT_KEY:localkey を動かして node test/sim3.mjs [URL]
//   ローカルの Durable Object は .wrangler/state に残るので、やり直す時は消す。
import { encodeRegister, encodeName3, encodeRecord3, encodeRecord, encodeName, rid30OfUid } from "../src/codec.js";

const base = process.argv[2] || "http://127.0.0.1:8799";
const fail = m => { throw new Error(m); };
async function send(ver, words, image, ip) {
  let last = "";
  for (const n of words) {
    const r = await fetch(`${base}/${ver}/${n}`, { headers: { accept: image ? "image/png" : "text/plain", "cf-connecting-ip": ip } });
    last = image ? "" : await r.text();
    if (image) await r.arrayBuffer();
  }
  return last;
}
const register = async (ip, uid) => { const t = await send(3, encodeRegister(uid), false, ip); return t.startsWith("id\t") ? Number(t.slice(3)) : t; };

// 移行：v2 の ID 410606822（ぽよたろう、登録簿の 1）の uid。下 30bit が 410606822 になる uid
const legacyUid = "abcdef12" + (410606822).toString(16).padStart(8, "0");
if (rid30OfUid(legacyUid) !== 410606822) fail("legacy uid");
const uidB = "0011223344556677", uidC = "8899aabbccddeeff";

const a = await register("10.0.0.1", legacyUid);
const b = await register("10.0.0.2", uidB);
const b2 = await register("10.0.0.5", uidB);                          // 同じ uid は別の場所からでも同じ ID
const c = await register("10.0.0.3", uidC);
console.log("ids", a, b, b2, c);
if (a !== 1) fail("legacy row should be reused: " + a);
if (b !== b2 || b === a || c === b || !(b > 3)) fail("ids");

if (await send(3, encodeName3(a, legacyUid, "ぽよたろう"), false, "10.0.0.1") !== "ok") fail("name a");
if (await send(3, encodeName3(b, uidB, "Rival"), false, "10.0.0.2") !== "ok") fail("name b");
if (await send(3, encodeName3(a, uidB, "なりすまし"), false, "10.0.0.9") !== "bad") fail("hijack must be rejected");

for (let m = 1; m <= 2; m++) {                                        // 9 ボールのランク戦 2 回（a 勝ち）
  await send(3, encodeRecord3({ rid: a, opp: b, kind: 0, ranked: 1, result: 1, mid: m }), true, "10.0.0.1");
  await send(3, encodeRecord3({ rid: b, opp: a, kind: 0, ranked: 1, result: 0, mid: m }), true, "10.0.0.2");
}
await send(3, encodeRecord3({ rid: 999, opp: a, kind: 0, ranked: 1, result: 1, mid: 3 }), true, "10.0.0.9");   // 登録されていない ID は捨てる
// 古いワールド（v2）：ミネラルむぎ茶（89809756 → 2）と、未登録の人（新しい ID が作られる）
await send(2, encodeRecord({ rid: 89809756, opp: 55555, kind: 1, ranked: 1, result: 1, mid: 7 }), false, "10.0.0.4");
await send(2, encodeName(55555, "OldWorld"), true, "10.0.0.6");
await send(2, encodeName(410606822, "v2で上書き"), true, "10.0.0.9");     // v3 で登録済みの人の名前は v2 で変えられない

// 相手がまだ登録していない（v2 の ID を印つきで送る）・相手の ID が登録簿に無い・古いワールドが新しい ID を相手として送る
await send(3, encodeRecord3({ rid: a, opp: 777777777, oppV2: true, kind: 0, ranked: 1, result: 1, mid: 8 }), true, "10.0.0.1");
await send(3, encodeRecord3({ rid: b, opp: 999, kind: 0, ranked: 1, result: 1, mid: 9 }), true, "10.0.0.2");
await send(2, encodeRecord({ rid: 89809756, opp: b, kind: 0, ranked: 1, result: 0, mid: 10 }), false, "10.0.0.4");

const d = await (await fetch(base + "/delta.txt?key=localkey&since=0,0")).text();
console.log(d);
const lines = d.trim().split("\n").map(l => l.split("\t"));
const recs = lines.filter(l => l[0] === "R"), names = lines.filter(l => l[0] === "P");
if (recs.length !== 8) fail("records " + recs.length);
const old = recs.find(r => r[8] === "7");
if (old[3] !== "2" || !(Number(old[4]) > 3)) fail("v2 record mapping " + old.join(" "));
const byMid = m => recs.find(r => r[8] === String(m));
if (!(Number(byMid(8)[4]) > 5) || byMid(8)[6] !== "1") fail("unregistered opponent (v2 id) " + byMid(8).join(" "));
if (byMid(9)[4] !== "0" || byMid(9)[6] !== "0") fail("unknown opponent should be dropped to unranked " + byMid(9).join(" "));
if (byMid(10)[4] !== String(b)) fail("old world sending a new id as opponent " + byMid(10).join(" "));
if (names.some(n => n[4] === "なりすまし" || n[4] === "v2で上書き")) fail("name hijack");
if (!names.some(n => n[4] === "OldWorld" && n[3] === old[4])) fail("v2 name mapping");
console.log("v3 ok");
