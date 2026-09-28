// Blit386Blaster - multiplayer asteroids where breaking rocks heals you.
//
// Fly with WASD (W/S thrust toward/away from the cursor, A/D strafe), aim with the mouse, hold the left button
// (or Space) to fire. Enemy bullets cost one health circle; the smallest rock fragments drop health circles, and
// every kill restores one too. Die and your kill count goes to a leaderboard that forgets scores after 5 minutes.
//
// Module map:
//   constants.ts  - every tuning knob
//   palette.ts    - fixed color slots plus one palette block per player
//   draw.ts       - circles and filled polygons (the engine draws pixels, lines, and rectangles natively)
//   sprites.ts    - the 8x8 ship, pre-rotated into 16 frames
//   starfield.ts  - endless parallax stars and planets
//   world.ts      - rocks, bullets, and pickups as shared-clock trajectories
//   net.ts        - relay connection and clock sync (game-agnostic)
//   session.ts    - who owns what, and every multiplayer message

import { BT, bootstrap, Vector2i } from 'blit386';

import {
    APP_ID,
    BOUNCE_RESTITUTION,
    BULLET_LIFE,
    BULLET_SPEED,
    FIRE_COOLDOWN,
    HUD_BOTTOM,
    HUD_TOP,
    PICKUP_BLINK,
    PICKUP_LIFETIME,
    PICKUP_RADIUS,
    RESPAWN_DELAY,
    ROCK_SIZES,
    SCREEN_H,
    SCREEN_W,
    SHIP_ACCEL,
    SHIP_DRAG,
    SHIP_MASS,
    SHIP_MAX_SPEED,
    SHIP_RADIUS,
    SHIP_REVERSE_ACCEL,
    SHIP_SEND_INTERVAL,
    SHIP_STRAFE_ACCEL,
    START_HEALTH,
    WORLD_MIN,
    shipScale,
    shipSpeedFactor,
} from './constants.ts';
import { circle, circleFill, convexPolygon, line, pixel, rectFill, text, textCentered, textWidth } from './draw.ts';
import { Leaderboard } from './leaderboard.ts';
import { C, allocPlayerColor, createPalette, randomShipHue, setPlayerColor } from './palette.ts';
import { type Profile, loadProfile, randomName, saveProfile } from './profile.ts';
import { type LocalShip, Session } from './session.ts';
import { buildShipSprites, drawShip } from './sprites.ts';
import { drawStarfield } from './starfield.ts';
import {
    type Bullet,
    type Motion,
    type Particle,
    type Rock,
    type Shard,
    bulletPos,
    randomRange,
    rockAngle,
    rockHitRadius,
    rockMotion,
    segmentHitsCircle,
    world,
} from './world.ts';

const PLAY_TOP = HUD_TOP;
const PLAY_BOTTOM = SCREEN_H - HUD_BOTTOM;
const VIEW_CENTER_X = SCREEN_W / 2;
const VIEW_CENTER_Y = PLAY_TOP + (PLAY_BOTTOM - PLAY_TOP) / 2;
const SPAWN_SHIELD = 2;
const MAX_PARTICLES = 2500;
const MAX_SHARDS = 600;
const TICK = 1 / 60;

type Phase = 'title' | 'playing' | 'dead';

declare global {
    interface Window {
        __game?: {
            state(): unknown;
            frame(): Promise<string>;
            /** Dev builds only: the live game object, for poking at it from the console or `blit play eval:`. */
            game: unknown;
        };
    }
}

/** ws(s)://host - the relay's base URL. `?relay=` overrides the build setting, handy for testing. */
function relayBaseUrl(): string {
    const override = new URLSearchParams(window.location.search).get('relay');

    return override ?? import.meta.env.VITE_RELAY_URL ?? 'ws://localhost:8787';
}

class Game {
    profile!: Profile;
    session!: Session;
    leaderboard!: Leaderboard;

    phase: Phase = 'title';
    ship: LocalShip = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, tx: 0, ty: 0, hp: 0, maxHp: 0, kills: 0, alive: false };
    colorBlock = 0;
    prevX = 0;
    prevY = 0;

    /** Camera top-left in world pixels. */
    camX = WORLD_MIN / 2 - VIEW_CENTER_X;
    camY = WORLD_MIN / 2 - VIEW_CENTER_Y;
    drift = { x: 14, y: 9 };

    fireCooldown = 0;
    sendTimer = 0;
    shieldUntil = 0;
    deadTime = 0;
    killedBy = '';
    lastScore = 0;
    toast = '';
    toastUntil = 0;

    particles: Particle[] = [];
    shards: Shard[] = [];
    /** Set by a DOM listener: the engine's per-frame press edge can miss a click shorter than one frame. */
    clickQueued = false;

    private readonly motion: Motion = { x: 0, y: 0, vx: 0, vy: 0 };
    private readonly polygon: number[] = [];

    configure() {
        return {
            displaySize: new Vector2i(SCREEN_W, SCREEN_H),
            maxCanvasSize: new Vector2i(SCREEN_W * 4, SCREEN_H * 4),
            targetFPS: 60,
            isCapturingKeyboardScroll: true,
        };
    }

    async init(): Promise<boolean> {
        createPalette();
        buildShipSprites();

        this.profile = loadProfile();
        this.colorBlock = allocPlayerColor(this.profile.hue);

        const relay = relayBaseUrl();

        this.leaderboard = new Leaderboard(relay);
        void this.leaderboard.refresh();

        this.session = new Session(`${relay}/${APP_ID}`, this.ship, this.profile, this.effects(), {
            scoredKill: (victim) => this.showToast(`DESTROYED ${victim.toUpperCase()}`),
            healed: () => {
                this.ship.hp = Math.min(this.ship.maxHp, this.ship.hp + 1);
            },
            enemyFired: (bullet) => this.hitTestWhileHidden(bullet),
        });
        void this.session.start();

        // Right-click should not open a menu over the game.
        document.addEventListener('contextmenu', (event) => {
            if (event.target instanceof HTMLCanvasElement) {
                event.preventDefault();
            }
        });
        document.addEventListener('pointerdown', (event) => {
            if (event.target instanceof HTMLCanvasElement && event.button === 0) {
                this.clickQueued = true;
            }
        });
        BT.hideCursor();

        if (BT.isDevMode) {
            window.__game = {
                state: () => ({
                    phase: this.phase,
                    status: this.session.status,
                    isHost: this.session.isHost,
                    selfId: this.session.selfId,
                    ship: { ...this.ship },
                    players: [...this.session.players.values()].map((p) => ({
                        id: p.id,
                        name: p.name,
                        alive: p.alive,
                        x: Math.round(p.dx),
                        y: Math.round(p.dy),
                        hp: p.hp,
                    })),
                    worldSize: world.size,
                    rocks: this.session.rocks.size,
                    pickups: this.session.pickups.size,
                    bullets: this.session.bullets.length,
                    particles: this.particles.length,
                }),
                frame: async () => blobToDataURL(await BT.captureFrame()),
                game: this,
            };
        }

        return true;
    }

    // --- Update ------------------------------------------------------------------------------------------------

    update(): void {
        this.session.update(TICK);
        this.updateParticles();

        const clicked = this.clickQueued || BT.isKeyPressed('Space') || BT.isKeyPressed('Enter');

        this.clickQueued = false;

        switch (this.phase) {
            case 'title':
                this.driftCamera();

                if (BT.isKeyPressed('KeyR')) {
                    this.rerollIdentity();
                } else if (clicked && this.session.hasWorld) {
                    this.spawn();
                }

                break;

            case 'playing':
                this.updateShip();
                break;

            case 'dead':
                this.deadTime += TICK;
                this.driftCamera();

                if (clicked && this.deadTime > RESPAWN_DELAY) {
                    this.spawn();
                }

                break;
        }
    }

    private spawn(): void {
        const s = this.ship;
        const size = world.size;
        const margin = Math.min(200, size * 0.15);
        let x = size / 2;
        let y = size / 2;

        for (let attempt = 0; attempt < 60; attempt++) {
            x = randomRange(margin, size - margin);
            y = randomRange(margin, size - margin);

            if (this.session.isClearOfShips(x, y, Math.min(300, size * 0.35)) && this.isClearOfRocks(x, y, 40)) {
                break;
            }
        }

        Object.assign(s, { x, y, vx: 0, vy: 0, tx: 0, ty: 0, hp: START_HEALTH, maxHp: START_HEALTH, kills: 0, alive: true });
        this.prevX = x;
        this.prevY = y;
        this.shieldUntil = this.session.now() + SPAWN_SHIELD;
        this.phase = 'playing';
        this.sendTimer = 0;
        this.session.sendShip();
    }

    private updateShip(): void {
        const s = this.ship;
        const t = this.session.now();

        this.prevX = s.x;
        this.prevY = s.y;

        // Aim: the nose always points at the cursor.
        if (BT.pointerPosValid(0)) {
            const pointer = BT.pointerPos(0);
            const wx = this.camX + pointer.x;
            const wy = this.camY + pointer.y;

            if (Math.hypot(wx - s.x, wy - s.y) > 1) {
                s.angle = Math.atan2(wy - s.y, wx - s.x);
            }
        }

        // Thrust relative to the facing: W/S along it, A/D across it. Every kill makes the ship a little sluggish.
        const fx = Math.cos(s.angle);
        const fy = Math.sin(s.angle);
        const pace = shipSpeedFactor(s.kills);
        const maxSpeed = SHIP_MAX_SPEED * pace;
        let ax = 0;
        let ay = 0;

        if (BT.isKeyDown('KeyW')) {
            ax += fx * SHIP_ACCEL * pace;
            ay += fy * SHIP_ACCEL * pace;
        }

        if (BT.isKeyDown('KeyS')) {
            ax -= fx * SHIP_REVERSE_ACCEL * pace;
            ay -= fy * SHIP_REVERSE_ACCEL * pace;
        }

        if (BT.isKeyDown('KeyD')) {
            ax -= fy * SHIP_STRAFE_ACCEL * pace;
            ay += fx * SHIP_STRAFE_ACCEL * pace;
        }

        if (BT.isKeyDown('KeyA')) {
            ax += fy * SHIP_STRAFE_ACCEL * pace;
            ay -= fx * SHIP_STRAFE_ACCEL * pace;
        }

        const thrust = Math.hypot(ax, ay);

        s.tx = thrust > 0 ? ax / thrust : 0;
        s.ty = thrust > 0 ? ay / thrust : 0;
        s.vx = (s.vx + ax * TICK) * SHIP_DRAG;
        s.vy = (s.vy + ay * TICK) * SHIP_DRAG;

        const speed = Math.hypot(s.vx, s.vy);

        if (speed > maxSpeed) {
            s.vx *= maxSpeed / speed;
            s.vy *= maxSpeed / speed;
        }

        s.x += s.vx * TICK;
        s.y += s.vy * TICK;

        this.bounceOffWalls();
        this.collideWithRocks(t);
        this.collideWithShips();

        if (thrust > 0) {
            this.emitExhaust(s.x, s.y, s.vx, s.vy, s.tx, s.ty, this.colorBlock, shipScale(s.kills));
        }

        this.fireCooldown -= TICK;

        if ((BT.isDown(BT.BTN_POINTER_A, 0) || BT.isKeyDown('Space')) && this.fireCooldown <= 0) {
            this.fireCooldown = FIRE_COOLDOWN;
            this.session.fire(
                s.x + fx * 5 * shipScale(s.kills),
                s.y + fy * 5 * shipScale(s.kills),
                fx * BULLET_SPEED + s.vx,
                fy * BULLET_SPEED + s.vy,
            );
        }

        this.checkBullets(t);
        this.checkPickups();

        if (!s.alive) {
            return;
        }

        this.sendTimer -= TICK;

        if (this.sendTimer <= 0) {
            this.sendTimer = SHIP_SEND_INTERVAL;
            this.session.sendShip();
        }

        this.centerCamera(s.x, s.y);
    }

    /** Our ship's collision radius; it grows with kills (see SHIP_GROW_AT_KILLS). */
    private shipRadius(): number {
        return SHIP_RADIUS * shipScale(this.ship.kills);
    }

    private bounceOffWalls(): void {
        const s = this.ship;
        const r = this.shipRadius();

        if (s.x < r) {
            s.x = r;
            s.vx = Math.abs(s.vx) * BOUNCE_RESTITUTION;
        } else if (s.x > world.size - r) {
            s.x = world.size - r;
            s.vx = -Math.abs(s.vx) * BOUNCE_RESTITUTION;
        }

        if (s.y < r) {
            s.y = r;
            s.vy = Math.abs(s.vy) * BOUNCE_RESTITUTION;
        } else if (s.y > world.size - r) {
            s.y = world.size - r;
            s.vy = -Math.abs(s.vy) * BOUNCE_RESTITUTION;
        }
    }

    /** Ships cannot pass through rocks: both bounce, weighted by mass, and nobody takes damage. */
    private collideWithRocks(t: number): void {
        const s = this.ship;

        for (const rock of this.session.rocks.values()) {
            const m = rockMotion(rock, t, this.motion);
            const reach = rockHitRadius(rock) + this.shipRadius();
            const dx = s.x - m.x;
            const dy = s.y - m.y;

            if (Math.abs(dx) > reach || Math.abs(dy) > reach) {
                continue;
            }

            const dist = Math.hypot(dx, dy);

            if (dist >= reach) {
                continue;
            }

            const nx = dist > 0 ? dx / dist : 1;
            const ny = dist > 0 ? dy / dist : 0;

            // Push the ship out so it never ends up inside.
            s.x = m.x + nx * reach;
            s.y = m.y + ny * reach;

            const closing = (s.vx - m.vx) * nx + (s.vy - m.vy) * ny;

            if (closing < 0) {
                const rockMass = ROCK_SIZES[rock.size].mass;
                const impulse = (-(1 + BOUNCE_RESTITUTION) * closing) / (1 / SHIP_MASS + 1 / rockMass);

                s.vx += (impulse / SHIP_MASS) * nx;
                s.vy += (impulse / SHIP_MASS) * ny;
                this.session.bumpRock(rock, m.vx - (impulse / rockMass) * nx, m.vy - (impulse / rockMass) * ny);
            }

            // Always leave with at least a little separation speed so the ship cannot get pinned.
            const away = s.vx * nx + s.vy * ny;

            if (away < 25) {
                s.vx += (25 - away) * nx;
                s.vy += (25 - away) * ny;
            }
        }
    }

    /** Ships bounce off each other too. Each player only moves their own ship, so this is half the exchange. */
    private collideWithShips(): void {
        const s = this.ship;
        for (const player of this.session.players.values()) {
            if (!player.alive || !player.hasState) {
                continue;
            }

            const reach = this.shipRadius() + SHIP_RADIUS * shipScale(player.kills);

            const dx = s.x - player.dx;
            const dy = s.y - player.dy;
            const dist = Math.hypot(dx, dy);

            if (dist >= reach || dist === 0) {
                continue;
            }

            const nx = dx / dist;
            const ny = dy / dist;
            const closing = (s.vx - player.vx) * nx + (s.vy - player.vy) * ny;

            s.x = player.dx + nx * reach;
            s.y = player.dy + ny * reach;

            if (closing < 0) {
                s.vx -= ((1 + BOUNCE_RESTITUTION) / 2) * closing * nx;
                s.vy -= ((1 + BOUNCE_RESTITUTION) / 2) * closing * ny;
            }
        }
    }

    /**
     * Bullets move several pixels per tick, so each one is tested as the segment it swept this tick.
     * - Our bullets hitting rocks: we are the authority, so report it.
     * - Anyone else's bullets hitting rocks or ships: just remove them locally; their owner or victim reports it.
     * - Enemy bullets hitting our ship: we are the authority for our own ship.
     */
    private checkBullets(t: number): void {
        const s = this.ship;
        const selfId = this.session.selfId;
        const prev = { x: 0, y: 0, vx: 0, vy: 0 };

        for (const bullet of this.session.bullets) {
            if (bullet.dead) {
                continue;
            }

            // Test everything the bullet covered since we last looked. A bullet whose "fire" message arrived late
            // is already partway along its path, and that first stretch must be tested too, or it can fly
            // straight through a ship without ever touching it in a single tick.
            const now = bulletPos(bullet, t, this.motion);
            const before = bulletPos(bullet, Math.max(bullet.t0, bullet.checkedUntil ?? bullet.t0), prev);
            const isMine = bullet.owner === selfId;

            bullet.checkedUntil = t;

            const rock = this.findRockOnSegment(before.x, before.y, now.x, now.y, t);

            if (rock) {
                if (isMine) {
                    this.session.reportRockHit(bullet, rock, now.x, now.y);
                } else {
                    bullet.dead = true;
                }

                continue;
            }

            if (isMine) {
                for (const player of this.session.players.values()) {
                    if (player.alive && segmentHitsCircle(before.x, before.y, now.x, now.y, player.dx, player.dy, SHIP_RADIUS * shipScale(player.kills) + 1)) {
                        bullet.dead = true;
                        break;
                    }
                }

                continue;
            }

            if (s.alive && t >= this.shieldUntil && segmentHitsCircle(before.x, before.y, now.x, now.y, s.x, s.y, this.shipRadius() + 1)) {
                this.takeHit(bullet);
            }
        }
    }

    /**
     * The game loop stops while the tab is in the background, but relayed messages still arrive. Our ship sits
     * still meanwhile, so an enemy bullet's whole remaining path can be tested the moment it is fired; otherwise a
     * player could dodge everything by switching tabs.
     */
    private hitTestWhileHidden(bullet: Bullet): void {
        const s = this.ship;
        const t = this.session.now();

        if (!document.hidden || !s.alive || t < this.shieldUntil) {
            return;
        }

        const start = bulletPos(bullet, Math.max(bullet.t0, t), { x: 0, y: 0, vx: 0, vy: 0 });
        const end = bulletPos(bullet, bullet.t0 + BULLET_LIFE, { x: 0, y: 0, vx: 0, vy: 0 });

        if (segmentHitsCircle(start.x, start.y, end.x, end.y, s.x, s.y, this.shipRadius() + 1)) {
            this.takeHit(bullet);
        }
    }

    private findRockOnSegment(ax: number, ay: number, bx: number, by: number, t: number): Rock | null {
        const m: Motion = { x: 0, y: 0, vx: 0, vy: 0 };

        for (const rock of this.session.rocks.values()) {
            rockMotion(rock, t, m);

            const r = rockHitRadius(rock);

            if (Math.abs(m.x - bx) > r + 12 || Math.abs(m.y - by) > r + 12) {
                continue;
            }

            if (segmentHitsCircle(ax, ay, bx, by, m.x, m.y, r)) {
                return rock;
            }
        }

        return null;
    }

    private takeHit(bullet: Bullet): void {
        const s = this.ship;

        this.session.reportHurt(bullet);
        s.hp -= 1;

        const speed = Math.hypot(bullet.vx, bullet.vy) || 1;

        this.effects().shipHurt(this.colorBlock, s.x, s.y, bullet.vx / speed, bullet.vy / speed);

        if (s.hp <= 0) {
            this.die(bullet.owner);
        }
    }

    private die(killerId: string): void {
        const s = this.ship;

        s.alive = false;
        s.hp = 0;
        this.phase = 'dead';
        this.deadTime = 0;
        this.lastScore = s.kills;
        this.killedBy = this.session.players.get(killerId)?.name ?? 'someone';
        this.effects().shipExploded(this.colorBlock, s.x, s.y);
        this.session.reportDeath(killerId);

        if (s.kills > this.profile.best) {
            this.profile.best = s.kills;
            saveProfile(this.profile);
        }

        if (s.kills > 0) {
            void this.leaderboard.submit(this.profile.id, this.profile.name, s.kills);
        } else {
            void this.leaderboard.refresh();
        }
    }

    private checkPickups(): void {
        const s = this.ship;

        if (s.hp >= s.maxHp) {
            return; // every circle is full: leave it for someone who needs it
        }

        const reach = this.shipRadius() + PICKUP_RADIUS + 1;

        for (const pickup of this.session.pickups.values()) {
            if (Math.abs(pickup.x - s.x) < reach && Math.abs(pickup.y - s.y) < reach) {
                if (Math.hypot(pickup.x - s.x, pickup.y - s.y) < reach) {
                    this.session.claimPickup(pickup);
                }
            }
        }
    }

    private isClearOfRocks(x: number, y: number, clearance: number): boolean {
        const t = this.session.now();

        for (const rock of this.session.rocks.values()) {
            const m = rockMotion(rock, t, this.motion);

            if (Math.hypot(m.x - x, m.y - y) < rockHitRadius(rock) + clearance) {
                return false;
            }
        }

        return true;
    }

    private centerCamera(x: number, y: number): void {
        this.camX = x - VIEW_CENTER_X;
        this.camY = y - VIEW_CENTER_Y;
    }

    /** While nobody is flying, the camera wanders the field and turns around at the edges. */
    private driftCamera(): void {
        this.camX += this.drift.x * TICK;
        this.camY += this.drift.y * TICK;

        if (this.camX < -40 || this.camX > world.size - SCREEN_W + 40) {
            this.drift.x = -this.drift.x;
        }

        if (this.camY < -40 || this.camY > world.size - SCREEN_H + 40) {
            this.drift.y = -this.drift.y;
        }
    }

    private rerollIdentity(): void {
        this.profile.name = randomName();
        this.profile.hue = randomShipHue();
        saveProfile(this.profile);
        setPlayerColor(this.colorBlock, this.profile.hue);
        this.session.send({ k: 'hello', name: this.profile.name, hue: this.profile.hue });
    }

    private showToast(message: string): void {
        this.toast = message;
        this.toastUntil = performance.now() + 3000;
    }

    // --- Particles ---------------------------------------------------------------------------------------------

    private effects() {
        return {
            rockHit: (x: number, y: number) => this.burst(x, y, 4, [C.ROCK_FLASH, C.ROCK_EDGE], 30, 90, 0.25),
            rockBroken: (size: number, x: number, y: number) =>
                this.burst(x, y, 6 + size * 8, [C.ROCK_EDGE, C.ROCK_FILL, C.ROCK_FLASH], 20, 70 + size * 15, 0.9),
            shipExploded: (block: number, x: number, y: number) => {
                this.burst(x, y, 50, [block, block + 1, block + 2], 20, 160, 1.2);
                this.scatterShards(x, y, 24, block, 0, 0);
            },
            shipHurt: (block: number, x: number, y: number, dx: number, dy: number) => {
                this.burst(x, y, 8, [C.ROCK_FLASH], 40, 120, 0.3);
                this.scatterShards(x, y, 9, block, dx, dy);
            },
        };
    }

    private burst(
        x: number,
        y: number,
        count: number,
        colors: number[],
        minSpeed: number,
        maxSpeed: number,
        life: number,
    ): void {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = randomRange(minSpeed, maxSpeed);
            const lifetime = life * randomRange(0.5, 1);

            this.addParticle(
                x,
                y,
                Math.cos(angle) * speed,
                Math.sin(angle) * speed,
                lifetime,
                colors[i % colors.length],
            );
        }
    }

    /** Engine exhaust: pixels squirt out opposite the thrust, in the ship's own color. */
    private emitExhaust(
        x: number,
        y: number,
        vx: number,
        vy: number,
        tx: number,
        ty: number,
        block: number,
        scale: number,
    ): void {
        for (let i = 0; i < 2; i++) {
            const speed = randomRange(60, 140);
            const spread = randomRange(-0.35, 0.35);
            const ex = -tx * Math.cos(spread) + ty * Math.sin(spread);
            const ey = -ty * Math.cos(spread) - tx * Math.sin(spread);

            this.addParticle(
                x + ex * 4 * scale,
                y + ey * 4 * scale,
                vx * 0.3 + ex * speed,
                vy * 0.3 + ey * speed,
                randomRange(0.2, 0.45),
                Math.random() < 0.3 ? block + 2 : block,
            );
        }
    }

    private addParticle(x: number, y: number, vx: number, vy: number, life: number, color: number): void {
        if (this.particles.length >= MAX_PARTICLES) {
            return;
        }

        this.particles.push({ x, y, vx, vy, life, maxLife: life, color });
    }

    /**
     * Knocks `count` line shards off a ship at (x, y). With a hit direction (dx, dy) they spray mostly along it,
     * the way the bullet was travelling; without one they fly every which way. They coast, spin, and hang in space
     * for several seconds, so a hit reads clearly even after the moment has passed.
     */
    private scatterShards(x: number, y: number, count: number, block: number, dx: number, dy: number): void {
        const hasDirection = dx !== 0 || dy !== 0;
        const heading = Math.atan2(dy, dx);

        for (let i = 0; i < count; i++) {
            if (this.shards.length >= MAX_SHARDS) {
                this.shards.shift();
            }

            const angle = hasDirection ? heading + randomRange(-1.1, 1.1) : Math.random() * Math.PI * 2;
            const speed = randomRange(25, 85);
            const life = randomRange(4, 7);

            this.shards.push({
                x: x + Math.cos(angle) * 2,
                y: y + Math.sin(angle) * 2,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                angle: Math.random() * Math.PI,
                spin: randomRange(-5, 5),
                length: 2 + Math.floor(Math.random() * 3),
                life,
                maxLife: life,
                color: i % 3 === 0 ? block + 2 : block,
                fadeColor: block + 1,
            });
        }
    }

    private updateShards(): void {
        for (let i = this.shards.length - 1; i >= 0; i--) {
            const shard = this.shards[i];

            shard.life -= TICK;

            if (shard.life <= 0) {
                this.shards.splice(i, 1);
                continue;
            }

            // Quick drag at first, so they burst out then drift lazily.
            shard.vx *= 0.985;
            shard.vy *= 0.985;
            shard.x += shard.vx * TICK;
            shard.y += shard.vy * TICK;
            shard.angle += shard.spin * TICK;
            shard.spin *= 0.995;
        }
    }

    private updateParticles(): void {
        this.updateShards();

        const list = this.particles;

        for (let i = list.length - 1; i >= 0; i--) {
            const p = list[i];

            p.life -= TICK;

            if (p.life <= 0) {
                list[i] = list[list.length - 1];
                list.pop();
                continue;
            }

            p.x += p.vx * TICK;
            p.y += p.vy * TICK;
            p.vx *= 0.97;
            p.vy *= 0.97;
        }

        // Remote ships squirt exhaust too, from the thrust direction in their last report.
        for (const player of this.session.players.values()) {
            if (player.alive && (player.tx !== 0 || player.ty !== 0)) {
                this.emitExhaust(
                    player.dx,
                    player.dy,
                    player.vx,
                    player.vy,
                    player.tx,
                    player.ty,
                    player.colorBlock,
                    shipScale(player.kills),
                );
            }
        }
    }

    // --- Render ------------------------------------------------------------------------------------------------

    render(): void {
        const t = this.session.now();
        const s = this.ship;
        let shipX = s.x;
        let shipY = s.y;

        if (this.phase === 'playing') {
            // Draw between the last two physics steps for smooth motion on high-refresh screens.
            shipX = this.prevX + (s.x - this.prevX) * BT.renderAlpha;
            shipY = this.prevY + (s.y - this.prevY) * BT.renderAlpha;
            this.centerCamera(shipX, shipY);
        }

        const cx = Math.round(this.camX);
        const cy = Math.round(this.camY);

        BT.clear(C.SPACE);
        drawStarfield(cx, cy);
        this.drawBoundary(cx, cy);
        this.drawRocks(cx, cy, t);
        this.drawPickups(cx, cy, t);
        this.drawParticles(cx, cy);
        this.drawShards(cx, cy);
        this.drawBullets(cx, cy, t);

        for (const player of this.session.players.values()) {
            if (player.alive && player.hasState) {
                drawShip(player.dx - cx, player.dy - cy, player.angle, player.colorBlock, shipScale(player.kills));
            }
        }

        if (s.alive) {
            const shielded = t < this.shieldUntil;

            if (!shielded || Math.floor(t * 10) % 2 === 0) {
                drawShip(shipX - cx, shipY - cy, s.angle, this.colorBlock, shipScale(s.kills));
            }
        }

        this.drawHud();

        if (this.phase === 'title') {
            this.drawTitle();
        } else if (this.phase === 'dead' && this.deadTime > 0.6) {
            this.drawDeath();
        }

        this.drawCrosshair();
    }

    private drawBoundary(cx: number, cy: number): void {
        const left = -cx;
        const top = -cy;
        const right = world.size - cx;
        const bottom = world.size - cy;
        const clampX = (x: number) => Math.max(-1, Math.min(SCREEN_W, x));
        const clampY = (y: number) => Math.max(-1, Math.min(SCREEN_H, y));

        if (top >= 0 && top < SCREEN_H) {
            line(clampX(left), top, clampX(right), top, C.YELLOW);
        }

        if (bottom >= 0 && bottom < SCREEN_H) {
            line(clampX(left), bottom, clampX(right), bottom, C.YELLOW);
        }

        if (left >= 0 && left < SCREEN_W) {
            line(left, clampY(top), left, clampY(bottom), C.YELLOW);
        }

        if (right >= 0 && right < SCREEN_W) {
            line(right, clampY(top), right, clampY(bottom), C.YELLOW);
        }
    }

    private drawPickups(cx: number, cy: number, t: number): void {
        for (const pickup of this.session.pickups.values()) {
            const x = pickup.x - cx;
            const y = pickup.y - cy;

            if (x < -8 || y < -8 || x > SCREEN_W + 8 || y > SCREEN_H + 8 || this.session.isClaimPending(pickup.id)) {
                continue;
            }

            // In its last seconds a pickup blinks (4 times a second) to warn it is about to vanish.
            const remaining = PICKUP_LIFETIME - (t - pickup.t0);

            if (remaining < PICKUP_BLINK && Math.floor(remaining * 8) % 2 === 1) {
                continue;
            }

            circleFill(x, y, PICKUP_RADIUS, C.RED);
        }
    }

    private drawRocks(cx: number, cy: number, t: number): void {
        const points = this.polygon;

        for (const rock of this.session.rocks.values()) {
            const m = rockMotion(rock, t, this.motion);
            const r = ROCK_SIZES[rock.size].radius;
            const x = m.x - cx;
            const y = m.y - cy;

            if (x < -r || y < -r || x > SCREEN_W + r || y > SCREEN_H + r) {
                continue;
            }

            const angle = rockAngle(rock, t);
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            points.length = rock.shape.length;

            for (let i = 0; i < rock.shape.length; i += 2) {
                const px = rock.shape[i];
                const py = rock.shape[i + 1];

                points[i] = Math.round(x + px * cos - py * sin);
                points[i + 1] = Math.round(y + px * sin + py * cos);
            }

            const flashing = t < rock.flashUntil;

            convexPolygon(points, flashing ? C.ROCK_FLASH : C.ROCK_FILL, flashing ? C.ROCK_FLASH : C.ROCK_EDGE);
        }
    }

    private drawBullets(cx: number, cy: number, t: number): void {
        for (const bullet of this.session.bullets) {
            if (bullet.dead) {
                continue;
            }

            const p = bulletPos(bullet, t, this.motion);

            pixel(p.x - cx, p.y - cy, C.YELLOW);
        }
    }

    private drawShards(cx: number, cy: number): void {
        for (const shard of this.shards) {
            const x = shard.x - cx;
            const y = shard.y - cy;

            if (x < -4 || y < -4 || x > SCREEN_W + 4 || y > SCREEN_H + 4) {
                continue;
            }

            const hx = (Math.cos(shard.angle) * shard.length) / 2;
            const hy = (Math.sin(shard.angle) * shard.length) / 2;

            line(x - hx, y - hy, x + hx, y + hy, shard.life < 1 ? shard.fadeColor : shard.color);
        }
    }

    private drawParticles(cx: number, cy: number): void {
        for (const p of this.particles) {
            const x = p.x - cx;
            const y = p.y - cy;

            if (x >= 0 && y >= 0 && x < SCREEN_W && y < SCREEN_H) {
                pixel(x, y, p.color);
            }
        }
    }

    private drawHud(): void {
        // Top band: one circle per health unit, filled when full, hollow when empty.
        rectFill(0, 0, SCREEN_W, HUD_TOP, C.HUD_BG);
        line(0, HUD_TOP - 1, SCREEN_W - 1, HUD_TOP - 1, C.HUD_LINE);

        const hp = this.ship.alive ? this.ship.hp : 0;
        const slots = this.ship.alive ? this.ship.maxHp : START_HEALTH;

        for (let i = 0; i < slots; i++) {
            const x = 7 + i * 10;

            if (i < hp) {
                circleFill(x, 5, 3, C.RED);
            } else {
                circle(x, 5, 3, C.RED);
            }
        }

        // Bottom band: kill count on the left, world position in the middle, notices on the right.
        const top = SCREEN_H - HUD_BOTTOM;

        rectFill(0, top, SCREEN_W, HUD_BOTTOM, C.HUD_BG);
        line(0, top, SCREEN_W - 1, top, C.HUD_LINE);
        text(4, top + 1, C.TEXT, `KILLS ${this.ship.kills}`);

        const [wx, wy] = this.ship.alive
            ? [this.ship.x, this.ship.y]
            : [this.camX + VIEW_CENTER_X, this.camY + VIEW_CENTER_Y];

        textCentered(SCREEN_W / 2, top + 1, C.TEXT_DIM, `${Math.round(wx)}, ${Math.round(wy)}`);

        let note = '';
        let noteColor: number = C.TEXT;

        if (performance.now() < this.toastUntil) {
            note = this.toast;
        } else if (this.session.status !== 'online') {
            note = this.session.status === 'connecting' ? 'CONNECTING' : 'OFFLINE';
            noteColor = C.TEXT_DIM;
        } else if (this.session.roomPrefix) {
            note = `ROOM ${this.session.roomPrefix.toUpperCase()}`;
            noteColor = C.TEXT_DIM;
        }

        if (note) {
            text(SCREEN_W - 4 - textWidth(note), top + 1, noteColor, note);
        }
    }

    private drawTitle(): void {
        const rows = this.scoreRows(7);
        const panel = this.drawPanel(260, 104 + rows * 9);
        let y = panel.y + 8;

        textCentered(SCREEN_W / 2, y, C.TEXT, 'B L I T 3 8 6   B L A S T E R');
        y += 14;
        textCentered(SCREEN_W / 2, y, C.TEXT_DIM, 'BREAK ROCKS TO HEAL. SHOOT PILOTS TO WIN.');
        y += 16;

        const nameWidth = textWidth(this.profile.name) + 14;
        const nameX = SCREEN_W / 2 - nameWidth / 2;

        drawShip(nameX + 4, y + 6, -Math.PI / 2, this.colorBlock);
        text(nameX + 14, y, this.colorBlock, this.profile.name);
        y += 11;
        textCentered(SCREEN_W / 2, y, C.TEXT_DIM, `BEST ${this.profile.best}   R: NEW NAME`);
        y += 15;
        this.drawScores(panel.x + 20, panel.x + panel.w - 20, y, rows);

        const prompt = this.session.hasWorld ? 'CLICK TO FLY' : 'JOINING...';

        textCentered(SCREEN_W / 2, panel.y + panel.h - 15, C.TEXT, prompt);
    }

    private drawDeath(): void {
        const rows = this.scoreRows(6);
        const panel = this.drawPanel(240, 76 + rows * 9);
        let y = panel.y + 8;

        textCentered(SCREEN_W / 2, y, C.TEXT, `DESTROYED BY ${this.killedBy.toUpperCase()}`);
        y += 13;
        textCentered(SCREEN_W / 2, y, C.TEXT_DIM, `KILLS ${this.lastScore}   BEST ${this.profile.best}`);
        y += 15;
        this.drawScores(panel.x + 20, panel.x + panel.w - 20, y, rows);

        if (this.deadTime > RESPAWN_DELAY) {
            textCentered(SCREEN_W / 2, panel.y + panel.h - 15, C.TEXT, 'CLICK TO FLY AGAIN');
        }
    }

    /** How many leaderboard lines to draw: the entries (up to `max`), or one line for the empty message. */
    private scoreRows(max: number): number {
        return Math.max(1, Math.min(max, this.leaderboard.entries.length));
    }

    private drawPanel(w: number, h: number): { x: number; y: number; w: number; h: number } {
        const x = Math.round(SCREEN_W / 2 - w / 2);
        const y = Math.round(VIEW_CENTER_Y - h / 2);

        rectFill(x, y, w, h, C.HUD_BG);
        line(x, y, x + w - 1, y, C.HUD_LINE);
        line(x, y + h - 1, x + w - 1, y + h - 1, C.HUD_LINE);
        line(x, y, x, y + h - 1, C.HUD_LINE);
        line(x + w - 1, y, x + w - 1, y + h - 1, C.HUD_LINE);

        return { x, y, w, h };
    }

    /** Top pilots of the last five minutes. */
    private drawScores(left: number, right: number, y: number, rows: number): void {
        textCentered(SCREEN_W / 2, y, C.TEXT_DIM, 'TOP PILOTS - LAST 5 MINUTES');
        y += 11;

        const entries = this.leaderboard.entries.slice(0, rows);

        if (entries.length === 0) {
            textCentered(SCREEN_W / 2, y, C.TEXT_DIM, this.leaderboard.isLoaded ? 'NO KILLS YET' : '...');

            return;
        }

        entries.forEach((entry, i) => {
            const color = entry.name === this.profile.name ? this.colorBlock : C.TEXT;
            const score = String(entry.score);

            text(left, y, C.TEXT_DIM, `${i + 1}.`);
            text(left + 16, y, color, entry.name);
            text(right - textWidth(score), y, color, score);
            y += 9;
        });
    }

    private drawCrosshair(): void {
        if (!BT.pointerPosValid(0)) {
            return;
        }

        const p = BT.pointerPos(0);

        circle(p.x, p.y, 4, C.RED);
        line(p.x - 8, p.y, p.x - 6, p.y, C.RED);
        line(p.x + 6, p.y, p.x + 8, p.y, C.RED);
        line(p.x, p.y - 8, p.x, p.y - 6, C.RED);
        line(p.x, p.y + 6, p.x, p.y + 8, C.RED);
        pixel(p.x, p.y, C.RED);
    }
}


function blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

bootstrap(Game);
