// プロトコル v3 への移行（2026-10-14、1 回だけ）：state/ の ID を v2 の ID（uid の下 30bit）から登録簿の新しい ID に書き換える。
//   対応は src/index.js の LegacyPlayers と同じ。docs/ は次の集計（tools/update.mjs）が書き直す。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const Root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const map = new Map([[410606822, 1], [89809756, 2], [237702707, 3]]);
const id = v => { const n = Number(v); if (n === 0) return 0; if (!map.has(n)) throw new Error("unknown id " + v); return map.get(n); };
const file = n => path.join(Root, "state", n);
const read = n => fs.readFileSync(file(n), "utf8").split("\n").filter(l => l.length > 0).map(l => l.split("\t"));
const write = (n, rows) => fs.writeFileSync(file(n), rows.map(r => r.join("\t")).join("\n") + (rows.length ? "\n" : ""));
const byNum = (...cols) => (p, q) => { for (const c of cols) { const d = Number(p[c]) - Number(q[c]); if (d) return d; } return 0; };

write("ratings.tsv", read("ratings.tsv").map(([r, k, x, g]) => [id(r), k, x, g]).sort(byNum(0, 1)));
write("stats.tsv", read("stats.tsv").map(([r, k, m, w]) => [id(r), k, m, w]).sort(byNum(0, 1)));
write("names.tsv", read("names.tsv").map(([r, n]) => [id(r), n]).sort(byNum(0)));
write("pending.tsv", read("pending.tsv").map(c => { c[2] = id(c[2]); c[3] = id(c[3]); return c; }));
write("done.tsv", read("done.tsv").map(([k, ts]) => { const [r, o, m] = k.split("|"); return [id(r) + "|" + id(o) + "|" + m, ts]; }));
write("recent.tsv", read("recent.tsv").map(([a, b, ts]) => { const x = id(a), y = id(b); return [Math.min(x, y), Math.max(x, y), ts]; }));
console.log("migrated", [...map].map(([o, n]) => o + "→" + n).join(" "));
