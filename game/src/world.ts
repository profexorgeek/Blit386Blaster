import {
    BULLET_LIFE,
    PICKUP_LIFETIME,
    ROCK_HIT_SCALE,
    ROCK_MAX_SPEED,
    ROCK_DENSITY,
    ROCK_MIN_MASS,
    ROCK_SIZES,
    WORLD_MAX,
    WORLD_MIN,
    WORLD_PER_PLAYER,
} from './constants.ts';

// World objects shared by every player. Rocks and bullets never need per-tick network updates: each one stores
// where it was at a shared time `t0` plus its velocity, and every client computes where it is now from the same
// clock (wall bounces included). Messages only go out when something changes its course.

/** The current world side length. Set by the host through the session; everything else reads it. */
export const world = { size: WORLD_MIN };

export function worldSizeFor(playerCount: number): number {
    return Math.min(WORLD_MAX, WORLD_MIN + WORLD_PER_PLAYER * Math.max(0, playerCount - 1));
}

export function rockTargetMass(size: number): number {
    return Math.max(ROCK_MIN_MASS, Math.round(size * size * ROCK_DENSITY));
}

export interface Rock {
    id: string;
    /** 3 = full size, 1 = smallest. */
    size: number;
    x0: number;
    y0: number;
    vx: number;
    vy: number;
    t0: number;
    hp: number;
    seed: number;
    /** Local-only: convex outline (flat x, y pairs around the center) and hit-flash timer. */
    shape: number[];
    flashUntil: number;
}

/** Compact wire form: [id, size, x0, y0, vx, vy, t0, hp, seed]. */
export type RockWire = [string, number, number, number, number, number, number, number, number];

export interface Bullet {
    id: string;
    owner: string;
    x0: number;
    y0: number;
    vx: number;
    vy: number;
    t0: number;
    dead: boolean;
    /** Local-only: how far along its path (shared-clock time) this client has already hit-tested it. */
    checkedUntil?: number;
}

export interface Pickup {
    id: string;
    x: number;
    y: number;
    t0: number;
}

export interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    color: number;
}

export interface Motion {
    x: number;
    y: number;
    vx: number;
    vy: number;
}

export function rockRadius(rock: Rock): number {
    return ROCK_SIZES[rock.size].radius;
}

export function rockHitRadius(rock: Rock): number {
    return ROCK_SIZES[rock.size].radius * ROCK_HIT_SCALE;
}

/** Where a rock is at time `t`, bouncing off the world edges, written into `out`. */
export function rockMotion(rock: Rock, t: number, out: Motion): Motion {
    const r = rockRadius(rock);
    const dt = t - rock.t0;

    reflect(rock.x0, rock.vx, dt, r, world.size - r, out, 'x');
    reflect(rock.y0, rock.vy, dt, r, world.size - r, out, 'y');

    return out;
}

/** Restarts a rock's path from where it is at `t` with a new velocity. */
export function rebaseRock(rock: Rock, t: number, vx: number, vy: number): void {
    const now = rockMotion(rock, t, scratchMotion);
    const speed = Math.hypot(vx, vy);
    const scale = speed > ROCK_MAX_SPEED ? ROCK_MAX_SPEED / speed : 1;

    rock.x0 = now.x;
    rock.y0 = now.y;
    rock.vx = vx * scale;
    rock.vy = vy * scale;
    rock.t0 = t;
}

export function rockAngle(rock: Rock, t: number): number {
    const spin = ((rock.seed % 1000) / 1000 - 0.5) * 1.2;

    return (rock.seed % 628) / 100 + spin * t;
}

const scratchMotion: Motion = { x: 0, y: 0, vx: 0, vy: 0 };

/**
 * 1D motion inside [lo, hi] with perfect reflections: unfold the path onto a line, then fold it back.
 * Positions in [0, L) of each 2L period move with the original velocity; [L, 2L) moves mirrored.
 */
function reflect(p0: number, v: number, dt: number, lo: number, hi: number, out: Motion, axis: 'x' | 'y'): void {
    const span = hi - lo;
    const unfolded = p0 - lo + v * dt;
    const m = ((unfolded % (2 * span)) + 2 * span) % (2 * span);
    const forward = m < span;
    const pos = lo + (forward ? m : 2 * span - m);

    if (axis === 'x') {
        out.x = pos;
        out.vx = forward ? v : -v;
    } else {
        out.y = pos;
        out.vy = forward ? v : -v;
    }
}

export function rockToWire(rock: Rock): RockWire {
    return [
        rock.id,
        rock.size,
        round1(rock.x0),
        round1(rock.y0),
        round1(rock.vx),
        round1(rock.vy),
        Math.round(rock.t0 * 1000) / 1000,
        rock.hp,
        rock.seed,
    ];
}

export function rockFromWire(wire: RockWire, previous?: Rock): Rock {
    const [id, size, x0, y0, vx, vy, t0, hp, seed] = wire;

    return {
        id,
        size,
        x0,
        y0,
        vx,
        vy,
        t0,
        hp,
        seed,
        shape: previous && previous.seed === seed ? previous.shape : rockShape(seed, ROCK_SIZES[size].radius),
        flashUntil: previous?.flashUntil ?? 0,
    };
}

/** A lumpy convex outline: random points on a ring, wrapped in their convex hull. Same seed, same rock. */
export function rockShape(seed: number, radius: number): number[] {
    let state = seed >>> 0 || 1;
    const rand = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;

        return (state >>> 0) / 0x100000000;
    };

    const count = 8 + Math.floor(rand() * 5);
    const points: [number, number][] = [];

    for (let i = 0; i < count; i++) {
        const angle = ((i + rand() * 0.7) / count) * Math.PI * 2;
        const dist = radius * (0.72 + rand() * 0.28);

        points.push([Math.cos(angle) * dist, Math.sin(angle) * dist]);
    }

    return convexHull(points).flat();
}

function convexHull(points: [number, number][]): [number, number][] {
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: [number, number][] = [];
    const upper: [number, number][] = [];

    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop();
        }

        lower.push(p);
    }

    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];

        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop();
        }

        upper.push(p);
    }

    return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function bulletPos(bullet: Bullet, t: number, out: Motion): Motion {
    const dt = t - bullet.t0;

    out.x = bullet.x0 + bullet.vx * dt;
    out.y = bullet.y0 + bullet.vy * dt;
    out.vx = bullet.vx;
    out.vy = bullet.vy;

    return out;
}

export function isBulletExpired(bullet: Bullet, t: number): boolean {
    if (bullet.dead || t - bullet.t0 > BULLET_LIFE) {
        return true;
    }

    const dt = t - bullet.t0;
    const x = bullet.x0 + bullet.vx * dt;
    const y = bullet.y0 + bullet.vy * dt;

    return x < 0 || y < 0 || x > world.size || y > world.size;
}

export function isPickupExpired(pickup: Pickup, t: number): boolean {
    return t - pickup.t0 > PICKUP_LIFETIME;
}

/**
 * Does the segment (ax, ay) -> (bx, by) pass within `r` of (cx, cy)? Bullets move several pixels per tick,
 * so testing the swept segment keeps them from skipping through small targets.
 */
export function segmentHitsCircle(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    r: number,
): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / lengthSq : 0;

    t = Math.max(0, Math.min(1, t));

    const px = ax + dx * t - cx;
    const py = ay + dy * t - cy;

    return px * px + py * py <= r * r;
}

export function randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}
