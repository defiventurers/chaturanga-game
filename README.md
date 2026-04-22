# Chaturanga Game

## Production deployment notes

### Frontend (Vercel / GitHub Pages)
Use the WebSocket server URL below in the online setup input (or `?server=` URL param):

- `wss://chaturanga-game.onrender.com`

The client now normalizes malformed values safely:
- `https://chaturanga-game.onrender.com` -> `wss://chaturanga-game.onrender.com`
- `chaturanga-game.onrender.com` -> `wss://chaturanga-game.onrender.com`

### Backend (Render Node Web Service)
Deploy from the `/server` directory.

Required settings:
- **Runtime**: Node
- **Root Directory**: `server`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment**: set `PORT` automatically by Render (no manual value required)

Backend behavior expected in production:
- listens on `process.env.PORT`
- binds to `0.0.0.0`
- health endpoint at `GET /`
- WebSocket protocol supports:
  - `create_room`
  - `join_room`
  - `set_ready`
  - `leave_room`
  - `roll_dice`
  - `make_move`
  - `promotion_decision`
  - `end_turn`

## Local run

### Backend
```bash
cd server
npm install
npm start
```

### Frontend
Open `index.html` in a browser and set WebSocket URL to `ws://localhost:8080` if needed.
