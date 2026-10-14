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

// ---- プロトコル v3（2026-10-14。仕様は docs/protocol-v3.md）----
//   ID はサーバーが配る（登録簿）。ID の前に長さの符号 2bit（0: 10bit・1: 16・2: 22・3: 30）。
//   文字列の経路 = 登録（種類 0）と名前（種類 1）、画像の経路 = 試合の記録。

export const IdBits = [10, 16, 22, 30];
export const RegisterWords = 7;
export function idCode(id) { return id < 1024 ? 0 : (id < 65536 ? 1 : (id < 4194304 ? 2 : 3)); }
function pushId(bits, id) { const c = idCode(id); pushBits(bits, id, IdBits[c]); }
function pushHex(bits, hex) { for (const ch of hex) pushBits(bits, parseInt(ch, 16), 4); }
function readHex(bits, from, digits) { let s = ""; for (let i = 0; i < digits; i++) s += readBits(bits, from + 4 * i, 4).toString(16); return s; }
function finish(bits) {
  pushBits(bits, check7(bits), 7);
  const words = bitsToWords(bits);
  words[0] += StartFlag;
  return words;
}
function checked(words, total) {
  const bits = wordsToBits(words);
  if (bits.length < total) return null;
  return readBits(bits, total - 7, 7) === check7(bits.slice(0, total - 7)) ? bits : null;
}
export function isUid(s) { return typeof s === "string" && /^[0-9a-f]{16}$/.test(s); }
/// uid の下 30bit（v2 の ID）
export function rid30OfUid(uid) { return parseInt(uid.slice(-8), 16) & 0x3FFFFFFF; }
/// 名前の合言葉：uid の先頭 24bit
export function tagOfUid(uid) { return parseInt(uid.slice(0, 6), 16); }

/// 文字列の経路のフレームの語数（最初の語の中身 11bit から）
export function stringFrameWords(first) {
  if ((first >> 10) === 0) return RegisterWords;
  const len = (first >> 5) & 31, code = (first >> 3) & 3;
  return Math.ceil((1 + 5 + 2 + IdBits[code] + 24 + 16 * len + 7) / WordBits);
}
/// 画像の経路（試合の記録）のフレームの語数
export function recordFrameWords(first) {
  const a = (first >> 9) & 3, b = (first >> 7) & 3;
  return Math.ceil((4 + IdBits[a] + IdBits[b] + 17) / WordBits);
}

/// 登録：種類 0・uid 64・検査 7 = 72bit = 7 語
export function encodeRegister(uid) {
  const bits = [0];
  pushHex(bits, uid);
  return finish(bits);
}
export function decodeRegister(words) {
  const bits = checked(words, 72);
  if (!bits || bits[0] !== 0) return null;
  return { uid: readHex(bits, 1, 16) };
}

/// 名前：種類 1・文字数 5・長さの符号 2・ID・合言葉 24・各文字 16・検査 7
export function encodeName3(id, uid, name) {
  const s = name.slice(0, MaxNameChars);
  const bits = [1];
  pushBits(bits, s.length, 5); pushBits(bits, idCode(id), 2); pushId(bits, id);
  pushBits(bits, tagOfUid(uid), 24);
  for (let i = 0; i < s.length; i++) pushBits(bits, s.charCodeAt(i), 16);
  return finish(bits);
}
export function decodeName3(words) {
  const first = words[0];
  if ((first >> 10) !== 1) return null;
  const len = (first >> 5) & 31, code = (first >> 3) & 3, n = IdBits[code];
  const bits = checked(words, 1 + 5 + 2 + n + 24 + 16 * len + 7);
  if (!bits || len === 0) return null;
  const id = readBits(bits, 8, n), tag = readBits(bits, 8 + n, 24);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(readBits(bits, 8 + n + 24 + 16 * i, 16));
  s = cleanName(s);
  return id > 0 && s.length > 0 ? { id, tag, name: s } : null;
}

/// 試合の記録：長さの符号 2 + 2・自分の ID・相手の ID（0 = 無し）・種目×2＋ランク戦 4・結果 2・試合番号の下 4・検査 7
///   相手の長さの符号 3（30bit）は「相手は v2 の ID（uid の下 30bit）」の印（相手がまだ登録していない時。r.oppV2）。
///   サーバーが配る ID は符号 2（約 419 万）までとする
export function encodeRecord3(r) {
  const bits = [];
  const oc = r.oppV2 ? 3 : idCode(r.opp);
  pushBits(bits, idCode(r.rid), 2); pushBits(bits, oc, 2);
  pushId(bits, r.rid); pushBits(bits, r.opp, IdBits[oc]);
  pushBits(bits, r.kind * 2 + r.ranked, 4); pushBits(bits, r.result, 2); pushBits(bits, r.mid & 15, 4);
  return finish(bits);
}
export function decodeRecord3(words) {
  const first = words[0];
  const a = IdBits[(first >> 9) & 3], b = IdBits[(first >> 7) & 3];
  const bits = checked(words, 4 + a + b + 17);
  if (!bits) return null;
  const at = 4 + a + b;
  const code = readBits(bits, at, 4);
  const r = { rid: readBits(bits, 4, a), opp: readBits(bits, 4 + a, b), kind: code >> 1, ranked: code & 1, result: readBits(bits, at + 4, 2), mid: readBits(bits, at + 6, 4) };
  if (r.rid === 0 || r.kind > 6 || r.result > 2 || (r.opp === r.rid && b !== 30)) return null;
  if (b === 30) r.oppV2 = true;
  return r;
}
