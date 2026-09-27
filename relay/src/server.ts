// Entry point: `node src/server.ts` (Node 22.18+ runs TypeScript directly).
// Reads the config from $RELAY_CONFIG, or ./config.json next to where you start it.

import { resolve } from 'node:path';

import { loadConfig } from './config.ts';
import { startRelay } from './relay.ts';

const configPath = resolve(process.env.RELAY_CONFIG ?? 'config.json');
const config = loadConfig(configPath);
const relay = await startRelay(config);

console.log(
    `[relay] listening on ${config.host}:${relay.port} with apps: ${Object.keys(config.apps).join(', ') || '(none)'}`,
);

async function shutdown(signal: string): Promise<void> {
    console.log(`[relay] ${signal}: shutting down`);
    await relay.close();
    process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
