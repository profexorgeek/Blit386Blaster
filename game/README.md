# Rockheal

Multiplayer asteroids where breaking rocks heals you. Built with [BLIT386](https://blit386.dev).

- **WASD** to fly: W/S thrust toward or away from the cursor, A/D strafe.
- **Mouse** to aim: the ship always points at the red crosshair.
- **Left click** (or Space) to fire.
- Every rock takes 3 hits per size and splits twice. The smallest pieces drop a red health circle.
- An enemy bullet costs one health circle. Each kill gives one back (10 at most).
- When you die, your kill count goes on a leaderboard that forgets scores after 5 minutes.
- **R** on the title screen gives you a new random name and color.

## Run it locally

Start the relay in one terminal, then the game in another:

```bash
cd ../relay && npm install && npm run dev
cd ../game && npm install && npm run dev
```

Open the printed address in two browser windows to play against yourself. In development the game connects to
`ws://localhost:8787` (set in `.env.development`). If it cannot reach a relay it still runs, solo, and keeps retrying in
the background.

Add `?relay=wss://relay.airpigengine.com` to the address to point any build at a different relay.

## Test

```bash
npm run typecheck
npm run test:mp      # two headless browsers against the local relay: hits, kills, healing, leaderboard, host hand-over
npx blit play --help # scripted single-player play-tests with screenshots
```

In dev builds, `window.__game.state()` summarizes the game, and `window.__game.game` is the live game object.

## Deploy to justindjohnson.com

```bash
npm run build
```

This writes a static site to `dist/` that connects to `wss://relay.airpigengine.com` (set in `.env.production`). Paths
are relative, so upload the contents of `dist/` to any folder, for example:

```bash
rsync -av --delete dist/ USER@YOUR_VPS:~/justindjohnson.com/games/rockheal/
```

## How the multiplayer works

There is no game server, only the [relay](../relay), which passes messages between players. Authority is split so nobody
waits on a round trip for what they feel directly:

- **Your ship is yours.** You move it and broadcast it 20 times a second. You decide when an enemy bullet hits it.
- **Your bullets are yours.** You decide when they hit a rock and tell everyone.
- **The host owns the rock field.** The longest-connected player applies rock damage, splits rocks, spawns new ones, and
  decides who grabbed a pickup first. When they leave, the next player already has the same field and takes over.

Rocks and bullets are sent once, as "here at time t, moving this fast", and every client works out where they are now
from a clock shared through the relay (wall bounces included). A rock only needs a new message when something changes
its path: a hit, a split, or a ship shoving it.

| File | What it does |
| --- | --- |
| `src/game.ts` | Local ship, input, collisions, particles, rendering, HUD, title and death screens |
| `src/session.ts` | Who owns what, and every multiplayer message |
| `src/net.ts` | Relay connection, room selection, clock sync (game-agnostic) |
| `src/world.ts` | Rocks, bullets, and pickups as shared-clock trajectories |
| `src/constants.ts` | Every tuning number |
| `src/palette.ts` | Color slots; each player gets a palette block for their ship color |
| `src/sprites.ts` | The 8x8 ship, rasterized at 16 angles (the engine cannot rotate sprites) |
| `src/draw.ts` | Circles and filled convex polygons (the engine draws pixels, lines, and rectangles) |
| `src/starfield.ts` | Endless parallax stars and planets, generated from a hash so nothing is stored |
| `src/profile.ts` | Name, color, and best score, kept in localStorage |
| `src/leaderboard.ts` | Reads and posts scores on the relay |
