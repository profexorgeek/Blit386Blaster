# Blit386 projects

| Folder | What |
| --- | --- |
| [`game/`](game) | **Rockheal**, a multiplayer asteroids game built with BLIT386. Deploys as static files to justindjohnson.com. |
| [`relay/`](relay) | A game-agnostic WebSocket relay (rooms, host election, clock sync, expiring scoreboards). Deploys to relay.airpigengine.com and can serve other games too. |

Quick start:

```bash
cd relay && npm install && npm run dev     # terminal 1
cd game && npm install && npm run dev      # terminal 2
```

Each folder's README covers testing and deployment.
