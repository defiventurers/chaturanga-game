# Arctic Dominion (Visual Re-theme)

This project is a **visual/branding re-theme** of the existing Chaturanga game.

## Current deployment setup

- **Frontend host**: Vercel
- **Room sync**: Vercel Serverless Function at `/api/rooms`
- **Shared room storage**: Vercel KV / Upstash Redis REST

Online rooms now sync through shared server storage instead of `localStorage`, so different phones, tablets, and computers can join the same room code.

## Vercel environment variables

Create a Vercel KV database (or an Upstash Redis database) and set these environment variables in the Vercel project:

```bash
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

The API also accepts Upstash's equivalent variable names:

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

If these variables are missing, the frontend keeps a local fallback so the game can still be tested on one device, but multi-device rooms require shared KV/Redis storage.

## Local development

### 1) Optional: set room storage variables

For real multi-device testing locally, export the same KV/Upstash REST variables used on Vercel.

### 2) Start frontend + API

Deploy with Vercel or run Vercel's local dev server so `/api/rooms` is available:

```bash
vercel dev
```

Then open the local Vercel URL in a browser. A player who creates a room gets a 6-character room code; other devices join with that code.

## Troubleshooting

- **Cannot sync between devices**
  - Confirm `/api/rooms?roomCode=XXXXXX` responds from the deployed domain.
  - Confirm `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or the Upstash equivalents) are set in Vercel.
  - Redeploy after changing environment variables.
- **Room code rejected**
  - Room IDs are 6 uppercase alphanumeric characters in the UI.
- **Room disappears later**
  - Rooms have a 24-hour TTL and are refreshed whenever room state is saved.
- **No room start countdown**
  - Countdown starts only when all required human seats are filled and every human player is ready.
