# Arctic Dominion (Visual Re-theme)

This project is a **visual/branding re-theme** of the existing Chaturanga game.

## Current deployment setup

- **Frontend host**: Vercel
- **Multiplayer backend**: Render Web Service
- **Realtime transport**: plain WebSocket using Node.js + `ws`
- **Backend folder**: `server/`

The browser game connects to the multiplayer server with:

```js
const ONLINE_ROOM_SERVER_URL = "wss://chaturanga-game.onrender.com";
```

Vercel should only serve the static frontend. Do not use Vercel `/api/rooms`, Vercel KV, Upstash, or Colyseus for this version.

## Render backend setup

Create a Render **Web Service** from this GitHub repository.

Use these settings exactly:

```text
Name: chaturanga-game
Root Directory: server
Runtime: Node
Build Command: npm install
Start Command: npm start
```

The server uses `process.env.PORT || 10000`, which is what Render expects for a Web Service.

## Backend health checks

After Render deploys, test:

```text
https://chaturanga-game.onrender.com/
```

Expected response:

```text
Arctic Dominion WebSocket server is running.
```

Then test:

```text
https://chaturanga-game.onrender.com/health
```

Expected response shape:

```json
{
  "ok": true,
  "rooms": 0,
  "clients": 0
}
```

## Local backend development

```bash
cd server
npm install
npm start
```

The local server runs on:

```text
http://localhost:10000
ws://localhost:10000
```

For production, keep the frontend pointed at:

```text
wss://chaturanga-game.onrender.com
```

## Troubleshooting

- **Online room does not create**
  - Open `https://chaturanga-game.onrender.com/health` first.
  - If that page does not load, the Render backend is not running.
- **Frontend says server timed out**
  - Free Render services can sleep. Open the health URL and wait for it to wake up, then retry.
- **Two devices do not sync**
  - Confirm both devices are using the same deployed Vercel frontend.
  - Confirm the frontend contains `ONLINE_ROOM_SERVER_URL = "wss://chaturanga-game.onrender.com"`.
  - Confirm Render logs show WebSocket connections.
- **Rooms disappear after restart**
  - This prototype stores rooms in memory. Render restart = rooms disappear. That is expected for now.
