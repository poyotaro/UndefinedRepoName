# UndefinedRepoName（仮）

PoyoPoyoBilliards の専用ワールドの全体ランキング用サーバー（Cloudflare Workers + D1）と、公開するランキングの JSON（GitHub Pages）。設計は Unity プロジェクトの `Assets/PoyoBilliardsWorld/docs/W0_design.md`。

## 現在：プロトコル v2（2026-10-12）

- `src/index.js`：受け口の Worker と、断片を組み立てて記録を保管する Durable Object（Assembler）。
- `src/codec.js`：送信の符号（ワールドの WorldRankingSender と同じ）。
- `tools/update.mjs`：集計。GitHub Actions（`.github/workflows/export.yml`、15 分ごと）が実行し、`state/` と `docs/`（Pages）を更新する。
- 仕様は `docs/protocol.md`。

ローカルの確認：
```
npx wrangler dev --local --port 8799     # .dev.vars に SALT と EXPORT_KEY=localkey
node test/sim.mjs
RANKING_URL=http://127.0.0.1:8799 RANKING_KEY=localkey RANKING_WAIT_MS=0 node tools/update.mjs <出力先>
```
