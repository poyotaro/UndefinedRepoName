// ランキングの送信の符号（プロトコル v2、2026-10-12）。Worker・Durable Object・集計（tools/update.mjs）・テストで共通。仕様は docs/protocol.md
//   URL /2/<n>（n = 0〜4095）の「どれを読むか」で 11bit ずつ送る。n >= 2048 はフレームの始まり、n < 2048 は続き。中身はどちらも下 11bit。
//   文字列の経路 = 試合の記録（77bit = 7 語）、画像の経路 = 名前。

export const WordBits = 11;
export const StartFlag = 2048;
export const RecordWords = 7;
export const MaxNameChars = 31;
export const KindCount = 6;          // 順位のある種目（0 9 ボール・1 10 ボール・2 8 ボール・3 スヌーカー・4 ピラミッド・5 3 クッション）。6 その他

function readBits(bits, from, count) {
  let v = 0;
  for (let i = 0; i < count; i++) v = v * 2 + (bits[from + i] || 0);
  return v;
}
function pushBits(bits, value, count) {
  for (let i = count - 1; i >= 0; i--) bits.push(Math.floor(value / Math.pow(2, i)) % 2);
}
function wordsToBits(words) {
  const bits = [];
  for (const w of words) pushBits(bits, w, WordBits);
  return bits;
}
function bitsToWords(bits) {
  const words = [];
  for (let i = 0; i < bits.length; i += WordBits) words.push(readBits(bits, i, WordBits));
  return words;
}

/// 7bit の検査値：中身を 10bit ずつに切った値 c_i（足りない分は 0）の Σ (i+1)·c_i mod 127
export function check7(bits) {
  let s = 0;
  for (let i = 0, k = 1; i < bits.length; i += 10, k++) s = (s + k * readBits(bits, i, 10)) % 127;
  return s;
}

/// 試合の記録：ID 30・相手の ID 30（0 = 1 対 1 でない・不明）・符号 4（種目×2＋ランク戦）・結果 2（0 負け・1 勝ち・2 引き分け）・試合番号の下 4bit・検査 7
export function encodeRecord(r) {
  const bits = [];
  pushBits(bits, r.rid, 30); pushBits(bits, r.opp, 30); pushBits(bits, r.kind * 2 + r.ranked, 4); pushBits(bits, r.result, 2); pushBits(bits, r.mid & 15, 4);
  pushBits(bits, check7(bits), 7);
  const words = bitsToWords(bits);
  words[0] += StartFlag;
  return words;
}
export function decodeRecord(words) {
  const bits = wordsToBits(words);
  const body = bits.slice(0, 70);
  if (readBits(bits, 70, 7) !== check7(body)) return null;
  const code = readBits(bits, 60, 4), result = readBits(bits, 64, 2);
  const r = { rid: readBits(bits, 0, 30), opp: readBits(bits, 30, 30), kind: code >> 1, ranked: code & 1, result, mid: readBits(bits, 66, 4) };
  if (r.rid === 0 || r.kind > 6 || r.result > 2 || r.opp === r.rid) return null;
  return r;
}

/// 名前：文字数 5・ID 30・各文字 16（UTF-16）・検査 7（ID と文字の部分に対して）
export function nameWordCount(len) { return Math.ceil((5 + 30 + 16 * len + 7) / WordBits); }
export function encodeName(rid, name) {
  const s = name.slice(0, MaxNameChars);
  const body = [];
  pushBits(body, rid, 30);
  for (const ch of s) for (let i = 0; i < ch.length; i++) pushBits(body, ch.charCodeAt(i), 16);
  const len = (body.length - 30) / 16;
  const bits = [];
  pushBits(bits, len, 5);
  bits.push(...body);
  pushBits(bits, check7(body), 7);
  const words = bitsToWords(bits);
  words[0] += StartFlag;
  return words;
}
export function decodeName(words) {
  const bits = wordsToBits(words);
  const len = readBits(bits, 0, 5);
  const body = bits.slice(5, 5 + 30 + 16 * len);
  if (len === 0 || readBits(bits, 5 + 30 + 16 * len, 7) !== check7(body)) return null;
  const rid = readBits(body, 0, 30);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(readBits(body, 30 + 16 * i, 16));
  s = cleanName(s);
  return rid > 0 && s.length > 0 ? { rid, name: s } : null;
}
/// ワールドの板もこれと同じ整え方で、自分の名前が登録済みか比べる
export function cleanName(s) { return s.replace(/[\t\r\n]/g, " ").trim(); }
