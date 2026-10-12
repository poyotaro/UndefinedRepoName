// PoyoPoyo Billiards のランキング（W5）。プロトコルは docs/protocol.md。
//   VRChat の Udon は読み込みしかできないので、ワールドが用意した 4096 本の URL（/0〜/4095）の「どれを読むか」で 12bit ずつ送る。
//   12bit = 上 2bit の見出し（3 報告の始まり・2 続き・1 名前の始まり）＋ 10bit の中身。経路（文字列・画像）ごとに順に届く。
//   試合の報告は 2 つの半分：文字列の経路で A（試合番号・結果・種目・ランク戦か）、画像の経路で B（プレイヤーの ID）。同じ IP の A と B を順に組む。
//   同じ試合の 2 人の報告がそろったら、ランク戦はレーティングを動かす（1 か所からだけの報告は動きを半分に、同じ相手との連戦は減らす）。
//   GET /export.txt で集計（ワールドが読む形）。GitHub Actions がこれを GitHub Pages に写す。
//   GET /bundle.txt で書き出し v2（種目ごとのランキング・自分の順位のファイル 64 個）の束（2026-10-12）。

import { Png1x1, receive, exportText, exportBundle, tryRate } from "./protocol.js";

const noStore = { "Cache-Control": "no-store, max-age=0" };

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") return new Response("method", { status: 405 });
    const path = new URL(request.url).pathname.slice(1);
    if (path === "export.txt") return new Response(await exportText(env), { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
    if (path === "bundle.txt") return new Response(await exportBundle(env), { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
    if (!/^\d{1,4}$/.test(path)) return new Response("not found", { status: 404 });
    const n = Number(path);
    if (n >= 4096) return new Response("not found", { status: 404 });
    const h = request.headers;
    const image = (h.get("accept") || "").includes("image/");
    const ip = h.get("cf-connecting-ip") || "?";
    ctx.waitUntil(receive(env, ip, image ? 1 : 0, n, Date.now()).catch(e => console.log("receive", e)));
    if (image) return new Response(Png1x1, { headers: { ...noStore, "Content-Type": "image/png" } });
    return new Response("ok", { headers: { ...noStore, "Content-Type": "text/plain" } });
  },

  async scheduled(event, env, ctx) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM frames WHERE ts < ?").bind(now - 5 * 60 * 1000),
      env.DB.prepare("DELETE FROM halves WHERE ts < ?").bind(now - 30 * 60 * 1000),
      env.DB.prepare("DELETE FROM reports WHERE ts < ?").bind(now - 30 * 24 * 3600 * 1000),
      env.DB.prepare("DELETE FROM counted WHERE ts < ?").bind(now - 30 * 24 * 3600 * 1000),
      env.DB.prepare("DELETE FROM rated WHERE ts < ?").bind(now - 30 * 24 * 3600 * 1000),
      env.DB.prepare("DELETE FROM sources WHERE ts < ?").bind(now - 30 * 24 * 3600 * 1000),
    ]);
    // 1 か所からだけ届いたランク戦（2 分以上たったもの）を半分の重みで反映する
    const pending = (await env.DB.prepare("SELECT match_id FROM reports WHERE ranked = 1 AND ts < ? AND ts > ? AND match_id NOT IN (SELECT match_id FROM rated) GROUP BY match_id HAVING COUNT(*) = 2")
      .bind(now - 2 * 60 * 1000, now - 3 * 3600 * 1000).all()).results;
    for (const p of pending) await tryRate(env, p.match_id, now, true);
  },
};

