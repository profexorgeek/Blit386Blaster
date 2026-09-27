# Blit386Blaster

Multiplayer asteroids in the browser, built with [BLIT386](https://blit386.dev). By Justin Johnson.

Break rocks to heal, shoot other pilots to grow your health bar, and climb a leaderboard that forgets everyone after
five minutes. Add `?room=yourname` to the address for a private room.

| Folder | What |
| --- | --- |
| [`game/`](game) | The game: a static site (Vite + TypeScript + BLIT386). |
| [`relay/`](relay) | A tiny game-agnostic WebSocket relay (rooms, host election, clock sync, expiring scoreboards). Runs on Render's free plan via [`render.yaml`](render.yaml). |

## Quick start

```bash
cd relay && npm install && npm run dev     # terminal 1
cd game && npm install && npm run dev      # terminal 2
```

## Deploy

1. **Relay:** in the [Render dashboard](https://dashboard.render.com), choose **New > Blueprint** and pick this repo.
   `render.yaml` sets up a free web service named `blit386blaster-relay`. Details in [`relay/README.md`](relay/README.md).
2. **Game:** make sure `game/.env.production` has the relay's URL, run `npm run build` in `game/`, and upload `dist/`
   anywhere that serves static files. Details in [`game/README.md`](game/README.md).
