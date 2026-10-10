# UndefinedRepoName（仮）

PoyoPoyoBilliards の専用ワールドの全体ランキング用サーバー（Cloudflare Workers + D1）と、公開するランキングの JSON（GitHub Pages）。設計は Unity プロジェクトの `Assets/PoyoBilliardsWorld/docs/W0_design.md`。

## 現在：W1 試作（送信の検証）

`src/index.js` は、VRChat の String Loading・Image Loading から来た `GET /<n>`（n = 0〜4095）を D1 の `probe_log` に記録するだけ。

```
npx wrangler d1 execute poyo-billiards-probe --remote --command "SELECT * FROM probe_log ORDER BY id DESC LIMIT 50"
```
