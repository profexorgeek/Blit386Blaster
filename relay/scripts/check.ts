// Checks a running relay end to end: opens a WebSocket, waits for the welcome, measures a ping, and reads the
// scoreboard. Run it against the live relay after deploying:
//
//   node scripts/check.ts wss://relay.airpigengine.com blit386blaster
//
// Pass an Origin with RELAY_ORIGIN if the relay restricts origins (default https://justindjohnson.com).

import { WebSocket } from 'ws';

import type { ServerMessage } from '../src/protocol.ts';

const [base = 'ws://localhost:8787', app = 'blit386blaster'] = process.argv.slice(2);
const origin = process.env.RELAY_ORIGIN ?? 'https://justindjohnson.com';
const url = `${base.replace(/\/+$/, '')}/${app}/relay-check`;

console.log(`Connecting to ${url} as ${origin} ...`);

const ws = new WebSocket(url, { origin });
const timeout = setTimeout(() => fail('no welcome within 10 seconds'), 10_000);

ws.on('unexpected-response', (_req, res) => fail(`HTTP ${res.statusCode} instead of a WebSocket upgrade`));
ws.on('error', (error) => fail(error.message));
ws.on('close', (code, reason) => fail(`closed with ${code} ${reason.toString()}`));
ws.on('message', async (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;

    if (message.t === 'welcome') {
        console.log(`OK  welcome: peer ${message.id}, ${message.peers.length} other peer(s) in the room`);
        ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
    } else if (message.t === 'pong') {
        console.log(`OK  ping round trip: ${Date.now() - message.c} ms`);

        const http = base.replace(/^ws/, 'http').replace(/\/+$/, '');
        const response = await fetch(`${http}/scores/${app}`, { headers: { Origin: origin } });

        console.log(`OK  GET /scores/${app}: HTTP ${response.status} ${await response.text()}`);
        clearTimeout(timeout);
        ws.removeAllListeners('close');
        ws.close();
    }
});

function fail(reason: string): never {
    console.error(`FAIL ${reason}`);
    process.exit(1);
}
