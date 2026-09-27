import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

import { type RelayConfig, isOriginAllowed, isValidName } from './config.ts';
import { type ClientMessage, CloseCode, type ServerMessage } from './protocol.ts';
import { Scoreboard, parseSubmission } from './scoreboard.ts';

interface Peer {
    id: string;
    ws: WebSocket;
    room: Room;
    isAlive: boolean;
    /** Token bucket for the per-peer message rate limit. */
    tokens: number;
    lastRefill: number;
}

interface Room {
    key: string;
    app: string;
    name: string;
    /** Insertion order is join order, so the first peer is always the host. */
    peers: Map<string, Peer>;
}

export interface Relay {
    server: Server;
    port: number;
    close(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;
const SCORE_POSTS_PER_MINUTE = 20;
const MAX_SCORE_BODY_BYTES = 2048;

export async function startRelay(config: RelayConfig): Promise<Relay> {
    const rooms = new Map<string, Room>();
    const scoreboards = new Map<string, Scoreboard>();
    const scorePostsByIp = new Map<string, { count: number; windowStart: number }>();

    for (const [app, appConfig] of Object.entries(config.apps)) {
        if (appConfig.scoreboard) {
            scoreboards.set(app, new Scoreboard(app, appConfig.scoreboard, config.dataDir));
        }
    }

    const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
    const server = createServer((req, res) => {
        handleHttp(req, res).catch((error: unknown) => {
            console.error('[relay] HTTP handler failed:', error);

            if (!res.headersSent) {
                sendJson(res, 500, { error: 'internal error' });
            }
        });
    });

    // --- WebSocket rooms ---------------------------------------------------------------------------------------

    server.on('upgrade', (req, socket, head) => {
        const [app, roomName] = pathParts(req.url);

        if (!isOriginAllowed(config, req.headers.origin)) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');

            return;
        }

        if (!app || !config.apps[app]) {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');

            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            if (!roomName || !isValidName(roomName)) {
                ws.close(CloseCode.BadRoomName, 'bad room name');

                return;
            }

            joinRoom(ws, app, roomName);
        });
    });

    function joinRoom(ws: WebSocket, app: string, roomName: string): void {
        const key = `${app}/${roomName}`;
        let room = rooms.get(key);

        if (!room) {
            room = { key, app, name: roomName, peers: new Map() };
            rooms.set(key, room);
        }

        const limit = config.apps[app].maxPeersPerRoom ?? config.maxPeersPerRoom;

        if (room.peers.size >= limit) {
            ws.close(CloseCode.RoomFull, 'room full');

            return;
        }

        const peer: Peer = {
            id: newPeerId(room),
            ws,
            room,
            isAlive: true,
            tokens: config.messageBurst,
            lastRefill: Date.now(),
        };

        const others = [...room.peers.keys()];

        room.peers.set(peer.id, peer);
        send(peer, { t: 'welcome', id: peer.id, host: hostOf(room), peers: others, time: Date.now() });
        broadcast(room, { t: 'join', id: peer.id }, peer.id);

        ws.on('pong', () => {
            peer.isAlive = true;
        });
        ws.on('message', (raw, isBinary) => onMessage(peer, raw.toString(), isBinary));
        ws.on('close', () => leaveRoom(peer));
        ws.on('error', () => ws.terminate());
    }

    function leaveRoom(peer: Peer): void {
        const room = peer.room;
        const wasHost = hostOf(room) === peer.id;

        if (!room.peers.delete(peer.id)) {
            return;
        }

        if (room.peers.size === 0) {
            rooms.delete(room.key);

            return;
        }

        broadcast(room, { t: 'leave', id: peer.id });

        if (wasHost) {
            broadcast(room, { t: 'host', id: hostOf(room) });
        }
    }

    function onMessage(peer: Peer, text: string, isBinary: boolean): void {
        if (isBinary) {
            send(peer, { t: 'error', message: 'binary frames are not supported' });

            return;
        }

        if (!takeToken(peer)) {
            send(peer, { t: 'error', message: 'rate limited' });

            return;
        }

        let message: ClientMessage;

        try {
            message = JSON.parse(text) as ClientMessage;
        } catch {
            send(peer, { t: 'error', message: 'invalid JSON' });

            return;
        }

        if (message.t === 'ping' && typeof message.c === 'number') {
            send(peer, { t: 'pong', c: message.c, s: Date.now() });

            return;
        }

        if (message.t === 'send') {
            // Stringify once and reuse the same frame for every recipient.
            const frame = JSON.stringify({ t: 'msg', from: peer.id, data: message.data } satisfies ServerMessage);

            if (message.to !== undefined) {
                const target = peer.room.peers.get(message.to);

                if (target) {
                    sendRaw(target, frame);
                } else {
                    send(peer, { t: 'error', message: `no peer ${message.to}` });
                }
            } else {
                for (const other of peer.room.peers.values()) {
                    if (other !== peer) {
                        sendRaw(other, frame);
                    }
                }
            }

            return;
        }

        send(peer, { t: 'error', message: 'unknown message type' });
    }

    function takeToken(peer: Peer): boolean {
        const now = Date.now();

        peer.tokens = Math.min(
            config.messageBurst,
            peer.tokens + ((now - peer.lastRefill) / 1000) * config.messagesPerSecond,
        );
        peer.lastRefill = now;

        if (peer.tokens < 1) {
            return false;
        }

        peer.tokens -= 1;

        return true;
    }

    // Drop connections that stopped answering pings (closed laptop lids, dead mobile networks).
    const heartbeat = setInterval(() => {
        for (const room of rooms.values()) {
            for (const peer of room.peers.values()) {
                if (!peer.isAlive) {
                    peer.ws.terminate();
                    continue;
                }

                peer.isAlive = false;
                peer.ws.ping();
            }
        }
    }, HEARTBEAT_MS);

    // --- HTTP: health, room list, scoreboards ------------------------------------------------------------------

    async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const origin = req.headers.origin;

        if (origin && isOriginAllowed(config, origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }

        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Access-Control-Max-Age', '86400');
            res.writeHead(204).end();

            return;
        }

        const [first, app] = pathParts(req.url);

        if (req.method === 'GET' && first === 'health') {
            sendJson(res, 200, { ok: true, rooms: rooms.size, time: Date.now() });

            return;
        }

        if (req.method === 'GET' && first === 'rooms' && app && config.apps[app]) {
            const list = [...rooms.values()]
                .filter((room) => room.app === app)
                .map((room) => ({ room: room.name, peers: room.peers.size }));

            sendJson(res, 200, list);

            return;
        }

        if (first === 'scores' && app) {
            const board = scoreboards.get(app);

            if (!board) {
                sendJson(res, 404, { error: 'no scoreboard for this app' });

                return;
            }

            if (req.method === 'GET') {
                sendJson(res, 200, board.top());

                return;
            }

            if (req.method === 'POST') {
                if (origin && !isOriginAllowed(config, origin)) {
                    sendJson(res, 403, { error: 'origin not allowed' });

                    return;
                }

                if (!allowScorePost(clientIp(req))) {
                    sendJson(res, 429, { error: 'too many score submissions' });

                    return;
                }

                const submission = parseSubmission(await readJsonBody(req));

                if (!submission) {
                    sendJson(res, 400, { error: 'expected {player, name, score}' });

                    return;
                }

                sendJson(res, 200, board.submit(submission));

                return;
            }
        }

        sendJson(res, 404, { error: 'not found' });
    }

    function allowScorePost(ip: string): boolean {
        const now = Date.now();
        const slot = scorePostsByIp.get(ip);

        if (!slot || now - slot.windowStart > 60_000) {
            scorePostsByIp.set(ip, { count: 1, windowStart: now });

            return true;
        }

        slot.count += 1;

        return slot.count <= SCORE_POSTS_PER_MINUTE;
    }

    const sweepIps = setInterval(() => {
        const cutoff = Date.now() - 60_000;

        for (const [ip, slot] of scorePostsByIp) {
            if (slot.windowStart < cutoff) {
                scorePostsByIp.delete(ip);
            }
        }
    }, 60_000);

    function clientIp(req: IncomingMessage): string {
        const forwarded = req.headers['x-forwarded-for'];

        if (config.trustProxy && typeof forwarded === 'string') {
            return forwarded.split(',')[0].trim();
        }

        return req.socket.remoteAddress ?? 'unknown';
    }

    // --- Start -------------------------------------------------------------------------------------------------

    await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));

    return {
        server,
        port: (server.address() as AddressInfo).port,
        async close() {
            clearInterval(heartbeat);
            clearInterval(sweepIps);

            for (const board of scoreboards.values()) {
                board.flush();
            }

            for (const client of wss.clients) {
                client.terminate();
            }

            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function hostOf(room: Room): string {
    return room.peers.keys().next().value ?? '';
}

function newPeerId(room: Room): string {
    let id: string;

    do {
        id = randomBytes(4).toString('hex');
    } while (room.peers.has(id));

    return id;
}

function send(peer: Peer, message: ServerMessage): void {
    sendRaw(peer, JSON.stringify(message));
}

function sendRaw(peer: Peer, frame: string): void {
    if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(frame);
    }
}

function broadcast(room: Room, message: ServerMessage, exceptId?: string): void {
    const frame = JSON.stringify(message);

    for (const peer of room.peers.values()) {
        if (peer.id !== exceptId) {
            sendRaw(peer, frame);
        }
    }
}

/** `/a/b?x=1` -> `['a', 'b']`. */
function pathParts(url: string | undefined): string[] {
    const path = (url ?? '/').split('?')[0];

    return path.split('/').filter((part) => part.length > 0).map(decodeURIComponent);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
        size += (chunk as Buffer).length;

        if (size > MAX_SCORE_BODY_BYTES) {
            return null;
        }

        chunks.push(chunk as Buffer);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return null;
    }
}
