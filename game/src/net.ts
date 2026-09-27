import type { ClientMessage, ServerMessage } from '../../relay/src/protocol.ts';

// Client side of the relay: joins a room, keeps a clock shared with every other peer, and hands relayed game
// messages to whoever listens. Knows nothing about this particular game.

/** Mirrors `CloseCode.RoomFull` in relay/src/protocol.ts. */
const ROOM_FULL = 4009;
const MAX_ROOMS_TO_TRY = 20;
const CLOCK_RESYNC_MS = 10_000;

export interface RelayEvents {
    onWelcome(selfId: string, hostId: string, peers: string[]): void;
    onJoin(id: string): void;
    onLeave(id: string): void;
    onHost(id: string): void;
    onMessage(from: string, data: unknown): void;
    onDisconnect(): void;
}

export class RelayClient {
    selfId = '';
    hostId = '';
    isConnected = false;

    private ws: WebSocket | null = null;
    /** relay clock (ms) = performance.now() + offset. Starts from the local wall clock until synced. */
    private offset = Date.now() - performance.now();
    private bestRtt = Infinity;
    private syncTimer: number | undefined;
    private readonly url: string;
    private readonly events: RelayEvents;

    constructor(url: string, events: RelayEvents) {
        this.url = url.replace(/\/+$/, '');
        this.events = events;
    }

    /** Seconds on the clock every peer shares. */
    now(): number {
        return (performance.now() + this.offset) / 1000;
    }

    get isHost(): boolean {
        return !this.isConnected || this.selfId === this.hostId;
    }

    /**
     * Joins the first room with space: `1`, then `2`, and so on. With a `prefix` (for private games or tests) the
     * rooms are `<prefix>-1`, `<prefix>-2`, ... Rejects if the relay cannot be reached.
     */
    async connect(prefix?: string): Promise<void> {
        for (let room = 1; room <= MAX_ROOMS_TO_TRY; room++) {
            const result = await this.tryRoom(prefix ? `${prefix}-${room}` : String(room));

            if (result === 'joined') {
                return;
            }

            if (result === 'failed') {
                throw new Error('relay unreachable');
            }
        }

        throw new Error('every room is full');
    }

    send(data: unknown, to?: string): void {
        this.sendRaw(to === undefined ? { t: 'send', data } : { t: 'send', data, to });
    }

    close(): void {
        window.clearInterval(this.syncTimer);
        this.ws?.close();
        this.ws = null;
        this.isConnected = false;
    }

    private tryRoom(room: string): Promise<'joined' | 'full' | 'failed'> {
        return new Promise((resolve) => {
            const ws = new WebSocket(`${this.url}/${room}`);
            let settled = false;

            ws.onmessage = (event) => {
                const message = JSON.parse(String(event.data)) as ServerMessage;

                if (!settled && message.t === 'welcome') {
                    settled = true;
                    this.ws = ws;
                    this.isConnected = true;
                    this.selfId = message.id;
                    this.hostId = message.host;
                    this.adoptClock(message.time, 0);
                    this.startClockSync();
                    this.events.onWelcome(message.id, message.host, message.peers);
                    resolve('joined');

                    return;
                }

                this.handle(message);
            };

            ws.onclose = (event) => {
                if (!settled) {
                    settled = true;
                    resolve(event.code === ROOM_FULL ? 'full' : 'failed');

                    return;
                }

                if (this.ws === ws) {
                    this.ws = null;
                    this.isConnected = false;
                    window.clearInterval(this.syncTimer);
                    this.events.onDisconnect();
                }
            };
        });
    }

    private handle(message: ServerMessage): void {
        switch (message.t) {
            case 'msg':
                this.events.onMessage(message.from, message.data);
                break;
            case 'join':
                this.events.onJoin(message.id);
                break;
            case 'leave':
                this.events.onLeave(message.id);
                break;
            case 'host':
                this.hostId = message.id;
                this.events.onHost(message.id);
                break;
            case 'pong': {
                const rtt = performance.now() - message.c;

                this.adoptClock(message.s, rtt);
                break;
            }
            case 'error':
                console.warn('[relay]', message.message);
                break;
        }
    }

    /**
     * Cristian's algorithm: the relay stamped `serverMs` about half a round trip ago. Keep the sample with the
     * shortest round trip, since it has the least uncertainty, but let the best slowly decay so drift is tracked.
     */
    private adoptClock(serverMs: number, rtt: number): void {
        if (rtt <= this.bestRtt * 1.2 || rtt === 0) {
            this.bestRtt = rtt === 0 ? Infinity : rtt;
            this.offset = serverMs + rtt / 2 - performance.now();
        }

        this.bestRtt *= 1.05;
    }

    private startClockSync(): void {
        this.bestRtt = Infinity;

        // A quick burst to lock in the clock, then a slow trickle to follow drift.
        for (let i = 0; i < 5; i++) {
            window.setTimeout(() => this.ping(), i * 150);
        }

        window.clearInterval(this.syncTimer);
        this.syncTimer = window.setInterval(() => this.ping(), CLOCK_RESYNC_MS);
    }

    private ping(): void {
        this.sendRaw({ t: 'ping', c: performance.now() });
    }

    private sendRaw(message: ClientMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }
}
