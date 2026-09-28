import {
    MAX_HEALTH,
    ROCK_HP,
    ROCK_SIZES,
    ROCK_SPAWN_CLEARANCE,
    ROCK_SPAWN_INTERVAL,
    SNAPSHOT_INTERVAL,
    WORLD_SHRINK_DELAY,
} from './constants.ts';
import { RelayClient } from './net.ts';
import { allocPlayerColor, freePlayerColor, setPlayerColor } from './palette.ts';
import {
    type Bullet,
    type Motion,
    type Pickup,
    type Rock,
    type RockWire,
    isBulletExpired,
    isPickupExpired,
    randomRange,
    rebaseRock,
    rockFromWire,
    rockMotion,
    rockShape,
    rockTargetMass,
    rockToWire,
    world,
    worldSizeFor,
} from './world.ts';

// The multiplayer layer. Authority is split so nobody waits on a round trip for things they feel directly:
//
// - Each player owns their own ship: they move it, and they decide when an enemy bullet hits it.
// - Each shooter decides when their own bullets hit a rock and tells everyone.
// - The host (the longest-connected player, chosen by the relay) owns the rock field and the health pickups:
//   it applies rock damage, splits rocks, spawns new ones, and settles who grabbed a pickup first.
//
// When the host leaves, the next player already has the same world and simply takes over.

type PickupWire = [string, number, number, number];

type GameMessage =
    | { k: 'hello'; name: string; hue: number }
    | {
          k: 'ship';
          ts: number;
          x: number;
          y: number;
          vx: number;
          vy: number;
          a: number;
          tx: number;
          ty: number;
          hp: number;
          kills: number;
          alive: boolean;
      }
    | { k: 'fire'; id: string; x: number; y: number; vx: number; vy: number; ts: number }
    | { k: 'hitRock'; rock: string; bullet: string; dx: number; dy: number }
    | { k: 'bump'; rock: RockWire }
    | { k: 'hurt'; bullet: string }
    | { k: 'died'; by: string; x: number; y: number }
    /** Full state from the host. `s` is the world size; the rocks' paths are already expressed for it. */
    | { k: 'world'; s: number; rocks: RockWire[]; pickups: PickupWire[] }
    | { k: 'rocks'; set: RockWire[]; gone: string[] }
    | { k: 'pickup'; p: PickupWire }
    | { k: 'claim'; id: string }
    | { k: 'taken'; id: string; by: string };

export interface LocalShip {
    x: number;
    y: number;
    vx: number;
    vy: number;
    angle: number;
    /** Thrust direction this tick (unit-ish vector, zero when coasting), drives exhaust particles. */
    tx: number;
    ty: number;
    hp: number;
    /** Health circles this life: starts at START_HEALTH, and only kills raise it. */
    maxHp: number;
    kills: number;
    alive: boolean;
}

export interface RemotePlayer {
    id: string;
    name: string;
    hue: number;
    colorBlock: number;
    hasState: boolean;
    alive: boolean;
    /** Latest reported state, stamped with the shared clock. */
    ts: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    angle: number;
    tx: number;
    ty: number;
    hp: number;
    kills: number;
    /** Smoothed position actually drawn and collided with. */
    dx: number;
    dy: number;
}

/** Visual reactions the session asks the game to play. */
export interface Effects {
    rockHit(x: number, y: number): void;
    /** A rock broke apart at (x, y). The rock object is already out of the field but still describes its shape. */
    rockBroken(rock: Rock, x: number, y: number): void;
    shipExploded(colorBlock: number, x: number, y: number): void;
    /** A ship took a hit from a bullet travelling along (dx, dy) (a unit vector, or zero if unknown). */
    shipHurt(colorBlock: number, x: number, y: number, dx: number, dy: number): void;
}

/** Callbacks for things that change the local player's own state. */
export interface LocalEvents {
    /** Someone died to one of our bullets. */
    scoredKill(victimName: string): void;
    /** The host confirmed we grabbed a pickup: refill one empty circle, never add a new one. */
    healed(): void;
    /** Someone fired; the game hit-tests it right away if its own loop is paused (a background tab). */
    enemyFired(bullet: Bullet): void;
}

const scratch: Motion = { x: 0, y: 0, vx: 0, vy: 0 };

export class Session {
    readonly relay: RelayClient;
    readonly players = new Map<string, RemotePlayer>();
    rocks = new Map<string, Rock>();
    pickups = new Map<string, Pickup>();
    bullets: Bullet[] = [];

    /** `?room=name` in the address puts you in your own set of rooms (private games, automated tests). */
    readonly roomPrefix = roomFromAddress();

    /** False until we have a world: either we are the host, or the host has sent us its snapshot. */
    hasWorld = false;
    status: 'connecting' | 'online' | 'offline' = 'connecting';

    private nextId = 0;
    private spawnTimer = 0;
    private snapshotTimer = 0;
    /** Seconds the player count has been asking for a smaller world. */
    private shrinkTimer = 0;
    private readonly pendingClaims = new Set<string>();
    /** Host rock changes waiting to go out together, so a busy fight stays under the relay's rate limit. */
    private readonly outgoingRocks = new Map<string, Rock>();
    private readonly outgoingGone = new Set<string>();
    private flushTimer: number | undefined;

    constructor(
        relayUrl: string,
        readonly local: LocalShip,
        private readonly profile: { name: string; hue: number },
        private readonly fx: Effects,
        private readonly events: LocalEvents,
    ) {
        this.relay = new RelayClient(relayUrl, {
            onWelcome: (_self, host, peers) => this.onWelcome(host, peers),
            onJoin: (id) => this.onJoin(id),
            onLeave: (id) => this.onLeave(id),
            onHost: () => this.onHostChanged(),
            onMessage: (from, data) => this.onMessage(from, data as GameMessage),
            onDisconnect: () => this.onDisconnect(),
        });
    }

    get selfId(): string {
        return this.relay.selfId || 'solo';
    }

    get isHost(): boolean {
        return this.relay.isHost;
    }

    now(): number {
        return this.relay.now();
    }

    /** Connects, falling back to a solo world if the relay is unreachable, and keeps retrying in the background. */
    async start(): Promise<void> {
        try {
            await this.relay.connect(this.roomPrefix);
            this.status = 'online';
        } catch (error) {
            console.warn('[session] playing offline:', error);
            this.status = 'offline';
            this.becomeSoloHost();
            this.scheduleReconnect();
        }
    }

    // --- Relay events ------------------------------------------------------------------------------------------

    private onWelcome(host: string, peers: string[]): void {
        this.status = 'online';
        this.send({ k: 'hello', name: this.profile.name, hue: this.profile.hue });

        if (host === this.relay.selfId) {
            // An empty room: keep the field we were flying in solo, or make a fresh one.
            if (this.rocks.size === 0) {
                this.seedWorld();
            }

            this.hasWorld = true;
        } else {
            // Someone else owns the field; drop ours and wait for their snapshot.
            this.hasWorld = false;
        }

        for (const id of peers) {
            this.ensurePlayer(id);
        }
    }

    private onJoin(id: string): void {
        this.ensurePlayer(id);
        this.send({ k: 'hello', name: this.profile.name, hue: this.profile.hue }, id);
        this.sendShip(id);

        if (this.isHost) {
            this.send(this.worldSnapshot(), id);
        }
    }

    private onLeave(id: string): void {
        const player = this.players.get(id);

        if (player) {
            freePlayerColor(player.colorBlock);
            this.players.delete(id);
        }
    }

    private onHostChanged(): void {
        if (this.isHost) {
            // We inherit the field as we last saw it; everyone else already agrees with it.
            this.hasWorld = true;
            this.spawnTimer = 0;
        }
    }

    private onDisconnect(): void {
        this.status = 'offline';

        for (const id of [...this.players.keys()]) {
            this.onLeave(id);
        }

        this.hasWorld = true;
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        window.setTimeout(async () => {
            try {
                await this.relay.connect(this.roomPrefix);
            } catch {
                this.scheduleReconnect();
            }
        }, 3000);
    }

    private becomeSoloHost(): void {
        if (this.rocks.size === 0) {
            this.seedWorld();
        }

        this.hasWorld = true;
    }

    // --- Messages ----------------------------------------------------------------------------------------------

    send(message: GameMessage, to?: string): void {
        if (this.relay.isConnected) {
            this.relay.send(message, to);
        }
    }

    private onMessage(from: string, message: GameMessage): void {
        const t = this.now();

        switch (message.k) {
            case 'hello': {
                const player = this.ensurePlayer(from);

                player.name = message.name.slice(0, 24);

                if (player.hue !== message.hue) {
                    player.hue = message.hue;
                    setPlayerColor(player.colorBlock, message.hue);
                }

                break;
            }

            case 'ship': {
                const player = this.ensurePlayer(from);

                if (message.ts < player.ts) {
                    break; // out of order; the relay keeps order, but be safe
                }

                const wasAlive = player.alive;

                Object.assign(player, {
                    ts: message.ts,
                    x: message.x,
                    y: message.y,
                    vx: message.vx,
                    vy: message.vy,
                    angle: message.a,
                    tx: message.tx,
                    ty: message.ty,
                    hp: message.hp,
                    kills: message.kills,
                    alive: message.alive,
                });

                if (!player.hasState || (!wasAlive && message.alive)) {
                    // First sighting or a respawn: appear exactly where they are instead of sliding there.
                    player.dx = message.x;
                    player.dy = message.y;
                }

                player.hasState = true;
                break;
            }

            case 'fire': {
                const bullet: Bullet = {
                    id: message.id,
                    owner: from,
                    x0: message.x,
                    y0: message.y,
                    vx: message.vx,
                    vy: message.vy,
                    t0: message.ts,
                    dead: false,
                };

                this.bullets.push(bullet);
                this.events.enemyFired(bullet);
                break;
            }

            case 'hitRock': {
                this.killBullet(message.bullet);

                const rock = this.rocks.get(message.rock);

                if (rock) {
                    const at = rockMotion(rock, t, scratch);

                    rock.flashUntil = t + 0.08;
                    this.fx.rockHit(at.x, at.y);

                    if (this.isHost) {
                        this.damageRock(rock, message.dx, message.dy);
                    }
                }

                break;
            }

            case 'bump':
                this.applyRockWire(message.rock);
                break;

            case 'hurt': {
                const bullet = this.bullets.find((b) => b.id === message.bullet);
                const speed = bullet ? Math.hypot(bullet.vx, bullet.vy) : 0;
                const player = this.players.get(from);

                this.killBullet(message.bullet);

                if (player) {
                    this.fx.shipHurt(
                        player.colorBlock,
                        player.dx,
                        player.dy,
                        speed > 0 ? bullet!.vx / speed : 0,
                        speed > 0 ? bullet!.vy / speed : 0,
                    );
                }

                break;
            }

            case 'died': {
                const player = this.players.get(from);

                if (player) {
                    player.alive = false;
                    this.fx.shipExploded(player.colorBlock, message.x, message.y);
                }

                if (message.by === this.relay.selfId && this.local.alive) {
                    this.local.kills += 1;
                    // A kill is the only way to earn a new health circle, and it arrives filled.
                    this.local.maxHp = Math.min(MAX_HEALTH, this.local.maxHp + 1);
                    this.local.hp = Math.min(this.local.maxHp, this.local.hp + 1);
                    this.events.scoredKill(player?.name ?? 'someone');
                }

                break;
            }

            case 'world':
                world.size = message.s;
                this.rocks = new Map(message.rocks.map((wire) => [wire[0], rockFromWire(wire, this.rocks.get(wire[0]))]));
                this.pickups = new Map(message.pickups.map((p) => [p[0], pickupFromWire(p)]));
                this.hasWorld = true;
                break;

            case 'rocks':
                for (const id of message.gone) {
                    const rock = this.rocks.get(id);

                    if (rock) {
                        const at = rockMotion(rock, t, scratch);

                        this.fx.rockBroken(rock, at.x, at.y);
                        this.rocks.delete(id);
                    }
                }

                for (const wire of message.set) {
                    this.applyRockWire(wire);
                }

                break;

            case 'pickup':
                this.pickups.set(message.p[0], pickupFromWire(message.p));
                break;

            case 'claim':
                if (this.isHost) {
                    this.settleClaim(message.id, from);
                }

                break;

            case 'taken':
                this.pickups.delete(message.id);
                this.pendingClaims.delete(message.id);

                if (message.by === this.relay.selfId) {
                    this.events.healed();
                }

                break;
        }
    }

    // --- Things the local player does --------------------------------------------------------------------------

    sendShip(to?: string): void {
        const s = this.local;

        this.send(
            {
                k: 'ship',
                ts: round3(this.now()),
                x: round1(s.x),
                y: round1(s.y),
                vx: round1(s.vx),
                vy: round1(s.vy),
                a: Math.round(s.angle * 100) / 100,
                tx: round1(s.tx),
                ty: round1(s.ty),
                hp: s.hp,
                kills: s.kills,
                alive: s.alive,
            },
            to,
        );
    }

    fire(x: number, y: number, vx: number, vy: number): void {
        const bullet: Bullet = {
            id: `${this.selfId}:${this.nextId++}`,
            owner: this.selfId,
            x0: x,
            y0: y,
            vx,
            vy,
            t0: this.now(),
            dead: false,
        };

        this.bullets.push(bullet);
        this.send({
            k: 'fire',
            id: bullet.id,
            x: round1(x),
            y: round1(y),
            vx: round1(vx),
            vy: round1(vy),
            ts: round3(bullet.t0),
        });
    }

    /** One of our bullets struck a rock. */
    reportRockHit(bullet: Bullet, rock: Rock, x: number, y: number): void {
        const t = this.now();

        bullet.dead = true;
        rock.flashUntil = t + 0.08;
        this.fx.rockHit(x, y);

        const speed = Math.hypot(bullet.vx, bullet.vy) || 1;
        const dx = Math.round((bullet.vx / speed) * 100) / 100;
        const dy = Math.round((bullet.vy / speed) * 100) / 100;

        this.send({ k: 'hitRock', rock: rock.id, bullet: bullet.id, dx, dy });

        if (this.isHost) {
            this.damageRock(rock, dx, dy);
        }
    }

    /** Our ship shoved a rock; everyone applies its new course right away. */
    bumpRock(rock: Rock, vx: number, vy: number): void {
        rebaseRock(rock, this.now(), vx, vy);
        this.send({ k: 'bump', rock: rockToWire(rock) });
    }

    /** An enemy bullet struck our ship. */
    reportHurt(bullet: Bullet): void {
        bullet.dead = true;
        this.send({ k: 'hurt', bullet: bullet.id });
    }

    reportDeath(killerId: string): void {
        this.send({ k: 'died', by: killerId, x: round1(this.local.x), y: round1(this.local.y) });
        this.sendShip();
    }

    claimPickup(pickup: Pickup): void {
        if (this.pendingClaims.has(pickup.id)) {
            return;
        }

        this.pendingClaims.add(pickup.id);

        if (this.isHost) {
            this.settleClaim(pickup.id, this.selfId);
        } else {
            this.send({ k: 'claim', id: pickup.id });
        }
    }

    isClaimPending(id: string): boolean {
        return this.pendingClaims.has(id);
    }

    // --- Per-tick upkeep ---------------------------------------------------------------------------------------

    update(dt: number): void {
        const t = this.now();

        this.bullets = this.bullets.filter((bullet) => !isBulletExpired(bullet, t));

        for (const [id, pickup] of this.pickups) {
            if (isPickupExpired(pickup, t)) {
                this.pickups.delete(id);
                this.pendingClaims.delete(id);
            }
        }

        this.smoothRemotePlayers(t);

        if (this.isHost && this.hasWorld) {
            this.hostUpdate(dt);
        }
    }

    /**
     * Remote ships are drawn where they should be *now*: extrapolated from their last report, with the drawn
     * position easing toward that target so corrections do not snap.
     */
    private smoothRemotePlayers(t: number): void {
        for (const player of this.players.values()) {
            if (!player.hasState) {
                continue;
            }

            const ahead = Math.min(0.25, Math.max(0, t - player.ts));
            const targetX = player.x + player.vx * ahead;
            const targetY = player.y + player.vy * ahead;

            if (Math.hypot(targetX - player.dx, targetY - player.dy) > 80) {
                player.dx = targetX;
                player.dy = targetY;
            } else {
                player.dx += (targetX - player.dx) * 0.35;
                player.dy += (targetY - player.dy) * 0.35;
            }
        }
    }

    // --- Host duties -------------------------------------------------------------------------------------------

    private hostUpdate(dt: number): void {
        this.spawnTimer -= dt;

        if (this.spawnTimer <= 0 && this.rockMass() < rockTargetMass(world.size)) {
            this.spawnTimer = ROCK_SPAWN_INTERVAL;

            const rock = this.spawnRock(this.now(), true);

            if (rock) {
                this.queueRockChange(rock);
            }
        }

        this.updateWorldSize(dt);
        this.snapshotTimer -= dt;

        if (this.snapshotTimer <= 0) {
            // A periodic full snapshot heals any drift from lost or reordered bumps.
            this.snapshotTimer = SNAPSHOT_INTERVAL;

            if (this.players.size > 0) {
                this.send(this.worldSnapshot());
            }
        }
    }

    /** Grows the world as soon as players join; shrinks it only after the smaller count has held for a while. */
    private updateWorldSize(dt: number): void {
        const wanted = worldSizeFor(this.players.size + 1);

        if (wanted > world.size) {
            this.resizeWorld(wanted);
            this.shrinkTimer = 0;
        } else if (wanted < world.size) {
            this.shrinkTimer += dt;

            if (this.shrinkTimer >= WORLD_SHRINK_DELAY) {
                this.resizeWorld(wanted);
                this.shrinkTimer = 0;
            }
        } else {
            this.shrinkTimer = 0;
        }
    }

    /**
     * Host only. Every rock path depends on the world size (it bounces off the edges), so each rock is restarted
     * from where it is right now. Rocks and pickups left outside a shrunken world are removed. Then everyone gets
     * the new world in one snapshot.
     */
    private resizeWorld(size: number): void {
        const t = this.now();

        for (const [id, rock] of this.rocks) {
            const m = rockMotion(rock, t, scratch);
            const r = ROCK_SIZES[rock.size].radius;

            if (m.x > size - r || m.y > size - r) {
                this.rocks.delete(id);
                continue;
            }

            Object.assign(rock, { x0: m.x, y0: m.y, vx: m.vx, vy: m.vy, t0: t });
        }

        for (const [id, pickup] of this.pickups) {
            if (pickup.x > size || pickup.y > size) {
                this.pickups.delete(id);
            }
        }

        world.size = size;
        this.send(this.worldSnapshot());
    }

    private seedWorld(): void {
        const t = this.now();

        world.size = worldSizeFor(this.players.size + 1);
        this.rocks.clear();
        this.pickups.clear();

        while (this.rockMass() < rockTargetMass(world.size)) {
            this.spawnRock(t, false);
        }
    }

    /** Full-size rocks count 1, halves 0.5, quarters 0.25, so a broken rock is not replaced until it is cleared. */
    private rockMass(): number {
        let mass = 0;

        for (const rock of this.rocks.values()) {
            mass += 2 ** (rock.size - 3);
        }

        return mass;
    }

    private spawnRock(t: number, awayFromShips: boolean): Rock | null {
        const { radius, minSpeed, maxSpeed } = ROCK_SIZES[3];

        for (let attempt = 0; attempt < 20; attempt++) {
            const x = randomRange(radius, world.size - radius);
            const y = randomRange(radius, world.size - radius);
            // In a small world "far from every ship" may not exist, so the clearance shrinks with it.
            const clearance = Math.min(ROCK_SPAWN_CLEARANCE, world.size * 0.3);

            if (awayFromShips && !this.isClearOfShips(x, y, clearance)) {
                continue;
            }

            const angle = Math.random() * Math.PI * 2;
            const speed = randomRange(minSpeed, maxSpeed);
            const rock = this.makeRock(3, x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, t);

            this.rocks.set(rock.id, rock);

            return rock;
        }

        return null;
    }

    isClearOfShips(x: number, y: number, clearance: number): boolean {
        if (this.local.alive && Math.hypot(this.local.x - x, this.local.y - y) < clearance) {
            return false;
        }

        for (const player of this.players.values()) {
            if (player.alive && Math.hypot(player.dx - x, player.dy - y) < clearance) {
                return false;
            }
        }

        return true;
    }

    private makeRock(size: number, x: number, y: number, vx: number, vy: number, t: number): Rock {
        const seed = Math.floor(Math.random() * 0x7fffffff);

        return {
            id: `${this.selfId}-${this.nextId++}`,
            size,
            x0: x,
            y0: y,
            vx,
            vy,
            t0: t,
            hp: ROCK_HP,
            seed,
            shape: rockShape(seed, ROCK_SIZES[size].radius),
            flashUntil: 0,
        };
    }

    /** Host only: one bullet's worth of damage. Three hits break a rock into two smaller ones. */
    private damageRock(rock: Rock, dx: number, dy: number): void {
        rock.hp -= 1;

        if (rock.hp > 0) {
            this.queueRockChange(rock);

            return;
        }

        const t = this.now();
        const at = rockMotion(rock, t, scratch);
        this.rocks.delete(rock.id);
        this.fx.rockBroken(rock, at.x, at.y);

        if (rock.size > 1) {
            // Fragments fly apart sideways to the shot, keeping some of the parent's drift.
            const child = ROCK_SIZES[rock.size - 1];
            const px = -dy;
            const py = dx;

            for (const side of [-1, 1]) {
                const speed = randomRange(child.minSpeed, child.maxSpeed);
                const x = clamp(at.x + px * side * child.radius * 0.8, child.radius, world.size - child.radius);
                const y = clamp(at.y + py * side * child.radius * 0.8, child.radius, world.size - child.radius);
                const piece = this.makeRock(
                    rock.size - 1,
                    x,
                    y,
                    at.vx * 0.5 + px * side * speed + dx * speed * 0.3,
                    at.vy * 0.5 + py * side * speed + dy * speed * 0.3,
                    t,
                );

                this.rocks.set(piece.id, piece);
                this.queueRockChange(piece);
            }
        }

        this.queueRockGone(rock.id);

        if (rock.size === 1) {
            const pickup: Pickup = { id: `${this.selfId}-${this.nextId++}`, x: at.x, y: at.y, t0: t };

            this.pickups.set(pickup.id, pickup);
            this.send({ k: 'pickup', p: pickupToWire(pickup) });
        }
    }

    private queueRockChange(rock: Rock): void {
        this.outgoingRocks.set(rock.id, rock);
        this.scheduleFlush();
    }

    private queueRockGone(id: string): void {
        this.outgoingRocks.delete(id);
        this.outgoingGone.add(id);
        this.scheduleFlush();
    }

    /** A timer rather than the game loop, so hits still go out while the host's tab is in the background. */
    private scheduleFlush(): void {
        this.flushTimer ??= window.setTimeout(() => {
            this.flushTimer = undefined;
            this.send({
                k: 'rocks',
                set: [...this.outgoingRocks.values()].map(rockToWire),
                gone: [...this.outgoingGone],
            });
            this.outgoingRocks.clear();
            this.outgoingGone.clear();
        }, 50);
    }

    private settleClaim(id: string, claimant: string): void {
        if (!this.pickups.has(id)) {
            return; // someone beat them to it
        }

        this.pickups.delete(id);
        this.pendingClaims.delete(id);
        this.send({ k: 'taken', id, by: claimant });

        if (claimant === this.selfId) {
            this.events.healed();
        }
    }

    private worldSnapshot(): GameMessage {
        return {
            k: 'world',
            s: world.size,
            rocks: [...this.rocks.values()].map(rockToWire),
            pickups: [...this.pickups.values()].map(pickupToWire),
        };
    }

    // --- Helpers -----------------------------------------------------------------------------------------------

    private applyRockWire(wire: RockWire): void {
        this.rocks.set(wire[0], rockFromWire(wire, this.rocks.get(wire[0])));
    }

    private killBullet(id: string): void {
        for (const bullet of this.bullets) {
            if (bullet.id === id) {
                bullet.dead = true;
            }
        }
    }

    private ensurePlayer(id: string): RemotePlayer {
        let player = this.players.get(id);

        if (!player) {
            player = {
                id,
                name: '...',
                hue: 210,
                colorBlock: allocPlayerColor(210),
                hasState: false,
                alive: false,
                ts: 0,
                x: 0,
                y: 0,
                vx: 0,
                vy: 0,
                angle: 0,
                tx: 0,
                ty: 0,
                hp: 0,
                kills: 0,
                dx: 0,
                dy: 0,
            };
            this.players.set(id, player);
        }

        return player;
    }
}

/**
 * The room name from `?room=`, cleaned up for the relay (letters, digits, `-` and `_`; the relay adds `-1`, `-2`...
 * so it is capped at 28 characters). Lowercase, so "MyRoom" and "myroom" meet in the same place.
 */
function roomFromAddress(): string | undefined {
    const raw = new URLSearchParams(window.location.search).get('room') ?? '';
    const clean = raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 28);

    return clean || undefined;
}

function pickupToWire(pickup: Pickup): PickupWire {
    return [pickup.id, round1(pickup.x), round1(pickup.y), round3(pickup.t0)];
}

function pickupFromWire([id, x, y, t0]: PickupWire): Pickup {
    return { id, x, y, t0 };
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
