import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ScoreboardConfig {
    /** Seconds a score stays on the board after it was set. */
    ttlSeconds: number;
    /** How many rows `GET /scores/<app>` returns. */
    keep: number;
}

export interface AppConfig {
    /** Omit to give the app no scoreboard. */
    scoreboard?: ScoreboardConfig;
    /** Overrides the global `maxPeersPerRoom` for this app. */
    maxPeersPerRoom?: number;
}

export interface RelayConfig {
    host: string;
    port: number;
    /**
     * Page origins allowed to connect and to use the scoreboard, e.g. `https://example.com`.
     * A trailing `:*` matches any port (`http://localhost:*`). An empty list allows every origin.
     */
    allowedOrigins: string[];
    /** Trust `X-Forwarded-For` for client IPs. Turn on when running behind a reverse proxy. */
    trustProxy: boolean;
    /** Where scoreboards are saved. Relative paths resolve against the config file. */
    dataDir: string;
    maxMessageBytes: number;
    maxPeersPerRoom: number;
    /** Sustained relayed messages per second per peer, plus a burst allowance on top. */
    messagesPerSecond: number;
    messageBurst: number;
    /** Only apps listed here can open rooms or keep scores. */
    apps: Record<string, AppConfig>;
}

const DEFAULTS: RelayConfig = {
    host: '127.0.0.1',
    port: 8787,
    allowedOrigins: [],
    trustProxy: false,
    dataDir: './data',
    maxMessageBytes: 262144,
    maxPeersPerRoom: 32,
    messagesPerSecond: 100,
    messageBurst: 200,
    apps: {},
};

export function loadConfig(path: string): RelayConfig {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RelayConfig>;
    const config: RelayConfig = { ...DEFAULTS, ...raw };

    config.dataDir = resolve(dirname(path), config.dataDir);

    // Hosting platforms (Render, Fly.io, ...) choose the port and need the server on every interface.
    if (process.env.PORT) {
        config.port = Number(process.env.PORT);
    }

    if (process.env.HOST) {
        config.host = process.env.HOST;
    }

    for (const [name, app] of Object.entries(config.apps)) {
        if (!isValidName(name)) {
            throw new Error(`Config: app name "${name}" must be 1-32 letters, digits, "-" or "_".`);
        }

        if (app.scoreboard && (app.scoreboard.ttlSeconds <= 0 || app.scoreboard.keep <= 0)) {
            throw new Error(`Config: app "${name}" scoreboard needs positive ttlSeconds and keep.`);
        }
    }

    return config;
}

export function isValidName(name: string): boolean {
    return /^[A-Za-z0-9_-]{1,32}$/.test(name);
}

export function isOriginAllowed(config: RelayConfig, origin: string | undefined): boolean {
    if (config.allowedOrigins.length === 0) {
        return true;
    }

    if (!origin) {
        return false;
    }

    return config.allowedOrigins.some((allowed) => {
        if (allowed.endsWith(':*')) {
            const base = allowed.slice(0, -2);

            return origin === base || (origin.startsWith(`${base}:`) && /^\d+$/.test(origin.slice(base.length + 1)));
        }

        return origin === allowed;
    });
}
