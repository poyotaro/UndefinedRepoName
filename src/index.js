// W1 試作：VRChat の String Loading・Image Loading からの GET を記録するだけの Worker。
// URL は https://<worker>/<n>（n = 0〜4095）。1 回の読み込みで 12bit を送る想定の検証用。

const PoolSize = 4096;

// 1×1 の透明な PNG（Image Loading が失敗しないように返す）
const Png1x1 = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
), c => c.charCodeAt(0));

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") return new Response("method", { status: 405 });

    const path = new URL(request.url).pathname.slice(1);
    if (!/^\d{1,4}$/.test(path)) return new Response("not found", { status: 404 });
    const n = Number(path);
    if (n >= PoolSize) return new Response("not found", { status: 404 });

    const now = Date.now();
    const h = request.headers;
    ctx.waitUntil(env.DB.prepare(
      "INSERT INTO probe_log (ts_ms, n, ip, ua, accept, country) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      now, n,
      h.get("cf-connecting-ip"),
      (h.get("user-agent") || "").slice(0, 200),
      (h.get("accept") || "").slice(0, 200),
      request.cf?.country ?? null
    ).run());

    // 同じ URL を何度も送るので、どこにもキャッシュさせない
    const noStore = { "Cache-Control": "no-store, max-age=0" };
    const accept = h.get("accept") || "";
    if (accept.includes("image/")) {
      return new Response(Png1x1, { headers: { ...noStore, "Content-Type": "image/png" } });
    }
    return new Response(`ok ${n} ${now}`, { headers: { ...noStore, "Content-Type": "text/plain" } });
  },
};
