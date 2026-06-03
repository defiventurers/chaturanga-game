# Arctic Dominion (Visual Re-theme)

This project is a **visual/branding re-theme** of the existing Chaturanga game.

## Current deployment setup

- **Frontend host**: Vercel
- **Multiplayer backend**: Plain Node.js WebSocket server using `ws`, deployed on Render
- **Room storage**: In-memory room map inside the Render Web Service

The existing `index.html` opens a raw WebSocket connection to the online room server and exchanges JSON messages for room creation, joining, polling, and updates.

## Multiplayer Server Setup

- Frontend runs on Vercel
- Backend runs on Render as a Web Service
- Root Directory on Render: `server`
- Build Command: `npm install`
- Start Command: `npm start`
- Health check URL: `https://YOUR-SERVICE.onrender.com/health`
- WebSocket URL for `index.html`: `wss://YOUR-SERVICE.onrender.com`

For the current production frontend, `index.html` is configured to use:

```js
const ONLINE_ROOM_SERVER_URL = "wss://chaturanga-game.onrender.com";
```

## Local development

### 1) Start the multiplayer server

```bash
cd server
npm install
npm start
```

The HTTP status page is available at `http://localhost:10000/`, and the health check is available at `http://localhost:10000/health`.

### 2) Start or open the frontend

Open `index.html` locally or deploy it with Vercel. If testing against a local WebSocket server, temporarily point `ONLINE_ROOM_SERVER_URL` in `index.html` at your local server URL, then change it back before deploying production.

A player who creates a room gets a 6-character room code; other devices join with that code through the Render WebSocket backend.

## Troubleshooting

- **Cannot connect to online rooms**
  - Confirm the Render Web Service is deployed from the `server` root directory.
  - Confirm the Render service starts with `npm start`.
  - Confirm `https://YOUR-SERVICE.onrender.com/health` returns JSON with `ok: true`.
  - Confirm `ONLINE_ROOM_SERVER_URL` in `index.html` points to the Render `wss://` URL.
- **Room code rejected**
  - Room IDs are 6 uppercase alphanumeric characters in the UI.
- **Room disappears later**
  - Rooms are stored in memory for this early prototype and disappear whenever the Render service restarts, redeploys, or scales to a different instance.
- **No room start countdown**
  - Countdown starts only when all required human seats are filled and every human player is ready.
