# MemePulse v1 live-data patch

This patch converts the repo from a simulated frontend into a real **DexScreener-backed live universe**:

- Solana only
- 100 tracked tokens
- 60 trending / 25 fresh / 15 persistence
- 15s fast refresh of tracked names
- 60s candidate-pool refresh
- 5m universe rebalance
- hard floors for liquidity + volume
- simple hysteresis via hold bonus + weak-cycle removal

## Files to add

Create these new files:

- `server/config.ts`
- `server/types.ts`
- `server/dexscreener.ts`
- `server/universe.ts`
- `server/index.ts`
- `src/types/live.ts`
- `src/services/liveApi.ts`
- `README_V1_SETUP.md`

## Files to replace

Overwrite these existing files:

- `package.json`
- `vite.config.ts`
- `.env.example`
- `src/pages/Dashboard.tsx`

## How to run locally

1. `npm install`
2. Create `.env.local` from `.env.example`
3. In one terminal: `npm run dev:server`
4. In another terminal: `npm run dev`
5. Open the frontend on port `3000`

The Vite dev server proxies `/api/*` to `http://localhost:3001`.

## What changed

The frontend no longer simulates social posts. Instead it reads from:

- `GET /api/health`
- `GET /api/live-universe`

The backend maintains an in-memory ranked universe using live DexScreener data. It is safe for MVP load because the tracked set is refreshed separately from discovery.
