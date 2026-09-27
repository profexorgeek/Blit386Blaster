import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { WebSocket } from 'ws';

import type { RelayConfig } from '../src/config.ts';
import type { ServerMessage } from '../src/protocol.ts';
import { type Relay, startRelay } from '../src/relay.ts';

const ORIGIN = 'http://localhost:5173';

let relay: Relay;
let base: string;

before(async () => {
    const config: RelayConfig = {
        host: '127.0.0.1',
        port: 0,
        allowedOrigins: ['http://localhost:*'],
        trustProxy: false,
        dataDir: mkdtempSync(join(tmpdir(), 'relay-test-')),
        maxMessageBytes: 4096,
        maxPeersPerRoom: 3,
        messagesPerSecond: 1000,
        messageBurst: 1000,
        apps: { demo: { scoreboard: { ttlSeconds: 300, keep: 3 } } },
    };

    relay = await startRelay(config);
    base = `127.0.0.1:${relay.port}`;
});

after(() => relay.close());

/** A test client that queues every message so tests can await them in order. */
class Client {
    ws: WebSocket;
    queue: ServerMessage[] = [];
    waiters: ((message: ServerMessage) => void)[] = [];
    closed: Promise<number>;

    constructor(path: string, origin = ORIGIN) {
        this.ws = new WebSocket(`ws://${base}${path}`, { origin });
        this.ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString()) as ServerMessage;
            const waiter = this.waiters.shift();

            if (waiter) {
                waiter(message);
            } else {
                this.queue.push(message);
            }
        });
        this.closed = new Promise((resolve) => this.ws.on('close', (code) => resolve(code)));
        this.ws.on('error', () => {});
    }

    next(): Promise<ServerMessage> {
        const queued = this.queue.shift();

        return queued ? Promise.resolve(queued) : new Promise((resolve) => this.waiters.push(resolve));
    }

    send(message: unknown): void {
        this.ws.send(JSON.stringify(message));
    }

    close(): void {
        this.ws.close();
    }
}

test('peers join, relay messages, and hand over host', async () => {
    const a = new Client('/demo/r1');
    const welcomeA = await a.next();

    assert.equal(welcomeA.t, 'welcome');
    assert.ok(welcomeA.t === 'welcome' && welcomeA.host === welcomeA.id);

    const b = new Client('/demo/r1');
    const welcomeB = await b.next();

    assert.ok(welcomeB.t === 'welcome');
    assert.deepEqual(welcomeB.peers, [welcomeA.t === 'welcome' ? welcomeA.id : '']);
    assert.deepEqual(await a.next(), { t: 'join', id: welcomeB.id });

    b.send({ t: 'send', data: { hello: 1 } });
    assert.deepEqual(await a.next(), { t: 'msg', from: welcomeB.id, data: { hello: 1 } });

    a.send({ t: 'send', data: 'direct', to: welcomeB.id });
    assert.deepEqual(await b.next(), { t: 'msg', from: welcomeA.id, data: 'direct' });

    a.close();
    assert.deepEqual(await b.next(), { t: 'leave', id: welcomeA.id });
    assert.deepEqual(await b.next(), { t: 'host', id: welcomeB.id });
    b.close();
});

test('ping answers with the relay clock', async () => {
    const a = new Client('/demo/r2');

    await a.next();
    a.send({ t: 'ping', c: 42 });

    const pong = await a.next();

    assert.ok(pong.t === 'pong' && pong.c === 42 && Math.abs(pong.s - Date.now()) < 1000);
    a.close();
});

test('full rooms and bad origins are refused', async () => {
    const clients = [new Client('/demo/r3'), new Client('/demo/r3'), new Client('/demo/r3')];

    await Promise.all(clients.map((client) => client.next()));

    const fourth = new Client('/demo/r3');

    assert.equal(await fourth.closed, 4009);

    const foreign = new Client('/demo/r4', 'https://evil.example');

    assert.equal(await foreign.closed, 1006);

    for (const client of clients) {
        client.close();
    }
});

test('scoreboard keeps one best row per player, sorted', async () => {
    const post = (body: unknown) =>
        fetch(`http://${base}/scores/demo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
            body: JSON.stringify(body),
        });

    await post({ player: 'p1', name: 'Ann', score: 5 });
    await post({ player: 'p2', name: 'Bo', score: 9 });
    await post({ player: 'p1', name: 'Ann', score: 2 }); // lower: ignored

    const response = await post({ player: 'p3', name: 'Cy\u0007', score: 7 });
    const rows = (await response.json()) as { name: string; score: number }[];

    assert.deepEqual(
        rows.map((row) => [row.name, row.score]),
        [
            ['Bo', 9],
            ['Cy', 7],
            ['Ann', 5],
        ],
    );
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);

    const bad = await post({ player: 'p4', name: 'X', score: -1 });

    assert.equal(bad.status, 400);
});
