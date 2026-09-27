# Relay

A small, game-agnostic WebSocket relay. It knows nothing about any particular game; games agree on their own message
formats and the relay just passes them along. One process can serve any number of games (Rockheal, AirPig, ...).

What it does:

- **Rooms.** Clients connect to `wss://<host>/<app>/<room>`. Anything a client sends goes to everyone else in that room
  (or to one peer by id). Rooms appear on first join and vanish when empty.
- **Host election.** The longest-connected peer in a room is its host. When the host leaves, the relay announces the next
  one. Games use this for whatever needs one owner (Rockheal's rock field).
- **Clock sync.** `ping`/`pong` with the relay's clock, so every peer can agree on "now" to within a few ms.
- **Scoreboards.** `GET/POST /scores/<app>` keeps the top N scores per app, one row per player, each expiring a set time
  after it was set.
- **Guard rails.** Allowed page origins, per-app room caps, message size and rate limits, dead-connection cleanup.

It is one Node process with one dependency (`ws`) and idles at roughly 40-60 MB of RAM.

## Protocol

All frames are JSON text. See [`src/protocol.ts`](src/protocol.ts) for the exact types.

| Direction | Message | Meaning |
| --- | --- | --- |
| client -> relay | `{t:'send', data, to?}` | Relay `data` to everyone else, or to peer `to` |
| client -> relay | `{t:'ping', c}` | Clock sync request (`c` = your clock, echoed back) |
| relay -> client | `{t:'welcome', id, host, peers, time}` | You joined; your id, the host, the others |
| relay -> client | `{t:'join', id}` / `{t:'leave', id}` | Someone came or went |
| relay -> client | `{t:'host', id}` | The host changed |
| relay -> client | `{t:'msg', from, data}` | A relayed message |
| relay -> client | `{t:'pong', c, s}` | Clock sync reply (`s` = relay clock, ms) |
| relay -> client | `{t:'error', message}` | Something was refused; the connection stays open |

Close codes: `4000` bad room name, `4009` room full (try another room), and an HTTP 403/404 on the upgrade for a
disallowed origin or unknown app.

HTTP endpoints:

| Endpoint | Returns |
| --- | --- |
| `GET /health` | `{ok, rooms, time}` |
| `GET /rooms/<app>` | `[{room, peers}]` |
| `GET /scores/<app>` | Top scores: `[{name, score, at}]` |
| `POST /scores/<app>` with `{player, name, score}` | The updated top scores |

## Configuration

Copy `config.example.json` to `config.json` and edit it. Every app that may use the relay must be listed under `apps`;
give it a `scoreboard` block if it keeps scores. Adding a game later is one more entry here and a restart.

```json
"apps": {
    "rockheal": { "scoreboard": { "ttlSeconds": 300, "keep": 10 }, "maxPeersPerRoom": 24 },
    "airpig":   { "maxPeersPerRoom": 8 }
}
```

`allowedOrigins` lists the sites whose pages may connect. `http://localhost:*` allows any local dev port.

## Run locally

```bash
npm install
npm run dev          # uses config.example.json, restarts on file changes
npm test             # end-to-end tests against a real relay on a random port
node scripts/check.ts ws://localhost:8787 rockheal
```

Needs Node 22.18 or newer, which runs the TypeScript sources directly (no build step).

## Deploy to the DreamHost VPS (relay.airpigengine.com)

The plan: the relay listens on `127.0.0.1:8787` (not reachable from outside), and the web server in front of it handles
HTTPS for `relay.airpigengine.com` and forwards to it. Browsers on justindjohnson.com then connect to
`wss://relay.airpigengine.com/rockheal/<room>`.

### 1. Install Node

DreamHost's system Node is usually old. Install your own with nvm as the user that will run the relay (no sudo needed):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
node -v   # must be 22.18 or newer
```

### 2. Copy the relay and install

From this repo on your machine:

```bash
rsync -av --exclude node_modules --exclude data relay/ USER@YOUR_VPS:~/relay/
```

On the VPS:

```bash
cd ~/relay
npm ci --omit=dev
cp config.example.json config.json   # then edit: origins, apps
node src/server.ts                   # quick test; Ctrl+C when you see "listening"
```

### 3. Keep it running

With sudo, use the systemd unit in [`deploy/relay.service`](deploy/relay.service) (instructions are at the top of the
file). It restarts the relay if it crashes and starts it on boot.

Without sudo, a user crontab works as a fallback: `crontab -e`, then add
`@reboot cd ~/relay && RELAY_CONFIG=~/relay/config.json ~/.nvm/versions/node/v24.21.0/bin/node src/server.ts >> ~/relay/relay.log 2>&1`.

### 4. Put relay.airpigengine.com in front of it

1. In the DreamHost panel, add `relay.airpigengine.com` as a domain on the VPS and turn on the free Let's Encrypt
   certificate for it.
2. Forward it to the relay. DreamHost's panel has a **Proxy Server** feature (for VPS and dedicated plans) that maps a
   domain to a local port: point `relay.airpigengine.com` at port `8787`.
3. Check it from your own machine:

   ```bash
   cd relay && node scripts/check.ts wss://relay.airpigengine.com rockheal
   ```

   Three `OK` lines means browsers can use it. If it fails with `HTTP 200` or `HTTP 400` instead of a WebSocket upgrade,
   the proxy is not forwarding WebSocket upgrades. In that case, ask DreamHost support to enable WebSocket proxying
   (Apache `mod_proxy_wstunnel`) for that domain, or, with sudo on the VPS, add it to the domain's Apache config:

   ```apache
   # Apache 2.4.47+ (check with `apache2 -v`); mod_proxy and mod_proxy_http must be enabled.
   ProxyPass        / http://127.0.0.1:8787/ upgrade=websocket
   ProxyPassReverse / http://127.0.0.1:8787/
   ```

   DreamHost manages its Apache configs and may overwrite hand edits, so prefer the panel or support if you can.

### Updating

`rsync` the files again, then `sudo systemctl restart relay`. Scoreboards live in `data/` and survive restarts.
