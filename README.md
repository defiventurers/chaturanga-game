# Chaturanga Game

## Current deployment setup

- **Frontend host**: Vercel
- **Backend host**: Render (Node Web Service)
- **Production WebSocket URL**: `wss://chaturanga-game.onrender.com`

> Deployment providers and production WebSocket URL are intentionally unchanged.

## Local development

### 1) Start backend (Render-equivalent service)
```bash
cd server
npm install
npm start
```

Expected backend behavior locally:
- listens on `process.env.PORT` (defaults to `10000`)
- health endpoint: `GET /`
- WebSocket endpoint on same host/port

### 2) Start frontend
Open `index.html` in a browser.

For online mode, use:
- `ws://localhost:10000` (or whichever local backend port you run)

## Troubleshooting

- **Cannot connect online**
  - Confirm backend is running and reachable.
  - Confirm URL scheme matches environment:
    - local: `ws://...`
    - production: `wss://chaturanga-game.onrender.com`
- **Room code rejected**
  - Room IDs must be 6 uppercase alphanumeric characters.
- **Disconnected during lobby/match**
  - Reconnect and rejoin the room if the server closed an idle/stale socket.
- **No room start countdown**
  - Countdown starts only when all seats are filled and every player is ready.
