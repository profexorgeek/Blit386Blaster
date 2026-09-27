// Wire protocol shared by the relay and its clients.
//
// The relay never looks inside `data`: it is whatever JSON value a game wants to pass around.
// Games connect to `wss://<relay>/<app>/<room>` and exchange these JSON text frames.

/** Messages a client sends to the relay. */
export type ClientMessage =
    /** Forward `data` to one peer (`to`) or, when `to` is omitted, to every other peer in the room. */
    | { t: 'send'; data: unknown; to?: string }
    /** Clock sync request. `c` is the client's own clock; it comes back untouched in the `pong`. */
    | { t: 'ping'; c: number };

/** Messages the relay sends to a client. */
export type ServerMessage =
    /** First message after connecting. `peers` excludes yourself. `time` is the relay clock in ms. */
    | { t: 'welcome'; id: string; host: string; peers: string[]; time: number }
    | { t: 'join'; id: string }
    | { t: 'leave'; id: string }
    /** The room's host changed (the previous host left). The host is always the longest-connected peer. */
    | { t: 'host'; id: string }
    /** A message relayed from another peer. */
    | { t: 'msg'; from: string; data: unknown }
    /** Clock sync reply: `c` echoes the request, `s` is the relay clock in ms when it answered. */
    | { t: 'pong'; c: number; s: number }
    /** Something the relay refused (bad JSON, rate limit, unknown peer). The connection stays open. */
    | { t: 'error'; message: string };

/** WebSocket close codes the relay uses (4000-4999 is the application range). */
export const CloseCode = {
    UnknownApp: 4004,
    OriginRejected: 4003,
    RoomFull: 4009,
    BadRoomName: 4000,
    RateLimited: 4029,
} as const;

/** One row of a scoreboard, as returned by `GET /scores/<app>`. */
export interface ScoreEntry {
    name: string;
    score: number;
    /** When the score was set, ms since the epoch. It drops off the board `ttlSeconds` later. */
    at: number;
}

/** Body for `POST /scores/<app>`. `player` is a stable per-player id, so one player holds one row. */
export interface ScoreSubmission {
    player: string;
    name: string;
    score: number;
}
