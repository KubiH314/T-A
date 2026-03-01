# MemePulse v2 upgrade notes

## What changed

1. **Buckets removed from the UI**
   - The BUCKET MIX summary card is gone.
   - The BUCKET column is removed from the main table.
   - The bucket badge (including the old Persistence label) is removed from the coin detail header.
   - The backend still keeps bucket logic for universe selection.

2. **DexScreener sync is more resilient**
   - Backend DexScreener calls now retry automatically on transient errors.
   - Universe refresh loops now avoid overlapping runs.
   - Frontend polling uses retry backoff and visibility wake-up logic, so the page re-syncs without a manual refresh.

3. **PUBLICITY is now mapped to backend `Publicity_Score`**
   - The main table PUBLICITY column and the detail panel Publicity Score use the backend YouTube score directly.
   - The backend now also exposes `Publicity_Score` in the JSON payload for clarity.

4. **Chart is synchronized and rescalable**
   - Price uses the live dashboard DexScreener stream.
   - Publicity Score uses backend publicity history plus the latest live snapshot.
   - New timeframe buttons: 10m, 30m, 1h, 12h, 24h.

5. **Financial Metrics / Publicity panels redesigned**
   - Replaced chunky cards with dense table rows.
   - Volume, Price Change, and Txns now use inline timeframe toggles.
   - Removed the old Jeed Ratio and Data Status rows.

6. **New Solana on-chain tracker service**
   - Added `server/solanaTracker.ts`.
   - Caches retention + median hold metrics in SQLite.
   - Safe fallback text is `New Launch - Calculating...` if there is no usable on-chain response yet.

## Files changed

- `src/pages/Dashboard.tsx`
- `src/services/liveApi.ts`
- `src/types/live.ts`
- `server/config.ts`
- `server/dexscreener.ts`
- `server/index.ts`
- `server/publicity.ts`
- `server/solanaTracker.ts`
- `.env`
- `.env.example`

## How to use in Codespaces

1. Replace your repo contents with this updated repo (or drag the changed files into your existing repo).
2. Add your secrets **in the terminal before starting the backend**:

```bash
export YOUTUBE_API_KEY="your-youtube-key"
export HELIUS_API_KEY="your-helius-key"
npm run dev:server
```

If you prefer `.env`, paste the keys into `.env` instead of exporting them.

## Why the keys are hidden now

- The repo no longer ships with a live YouTube key.
- `.env` and `.env.example` contain blank placeholders.
- This prevents someone else from burning your quota or reusing your project credentials.
