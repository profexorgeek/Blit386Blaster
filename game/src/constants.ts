// Every tunable number in the game lives here. Distances are pixels, speeds are pixels per second,
// times are seconds.

export const APP_ID = 'blit386blaster';

export const SCREEN_W = 480;
export const SCREEN_H = 270;

/** Reserved HUD bands: health circles along the top, kill count along the bottom. */
export const HUD_TOP = 11;
export const HUD_BOTTOM = 12;

/**
 * The world is a square whose side grows with the number of connected players: WORLD_MIN alone, plus
 * WORLD_PER_PLAYER for each extra player, capped at WORLD_MAX (reached at 19 players). The host decides the size;
 * it grows as soon as someone joins, but waits WORLD_SHRINK_DELAY seconds before shrinking so a quick reconnect
 * does not squeeze everyone.
 */
export const WORLD_MIN = 500;
export const WORLD_MAX = 5000;
export const WORLD_PER_PLAYER = 250;
export const WORLD_SHRINK_DELAY = 10;

// --- Ships ---
/** Collision radius of a 1x ship. Bigger phases multiply it (see shipScale). */
export const SHIP_RADIUS = 4;
export const SHIP_ACCEL = 420;
export const SHIP_STRAFE_ACCEL = 340;
export const SHIP_REVERSE_ACCEL = 300;
export const SHIP_MAX_SPEED = 220;
/** Fraction of velocity kept per tick (60 Hz). */
export const SHIP_DRAG = 0.985;
export const SHIP_MASS = 1;
export const SHIP_ROTATIONS = 16;

/**
 * Successful pilots become easier targets. Kill counts (this life) at which the ship grows to 2x and 3x size;
 * its hit circle grows with it.
 */
export const SHIP_GROW_AT_KILLS = [5, 10];

/** Each kill takes this fraction off thrust and top speed, down to SHIP_MIN_SPEED_FACTOR. */
export const KILL_SLOWDOWN = 0.03;
export const SHIP_MIN_SPEED_FACTOR = 0.6;

/** 1, 2 or 3: how many times bigger than the base 8x8 a ship with `kills` kills is. */
export function shipScale(kills: number): number {
    return 1 + SHIP_GROW_AT_KILLS.filter((threshold) => kills >= threshold).length;
}

export function shipSpeedFactor(kills: number): number {
    return Math.max(SHIP_MIN_SPEED_FACTOR, 1 - KILL_SLOWDOWN * kills);
}

/** Health circles at spawn. Kills add a circle (up to MAX_HEALTH); pickups only refill existing ones. */
export const START_HEALTH = 3;
export const MAX_HEALTH = 10;

// --- Bullets ---
export const BULLET_SPEED = 380;
export const BULLET_LIFE = 1.1;
export const FIRE_COOLDOWN = 0.28;

// --- Asteroids ---
export interface RockSize {
    radius: number;
    mass: number;
    minSpeed: number;
    maxSpeed: number;
}

/** Index by size: 3 is full size, 1 is the smallest. */
export const ROCK_SIZES: Record<number, RockSize> = {
    3: { radius: 26, mass: 8, minSpeed: 10, maxSpeed: 35 },
    2: { radius: 15, mass: 3, minSpeed: 20, maxSpeed: 50 },
    1: { radius: 8, mass: 1.5, minSpeed: 30, maxSpeed: 65 },
};
export const ROCK_HP = 3;
/** Collision circle as a fraction of the drawn radius (the polygon is a little smaller than its circle). */
export const ROCK_HIT_SCALE = 0.9;
export const ROCK_MAX_SPEED = 120;
/**
 * The host keeps the field topped up to this many full-size rocks' worth of mass per square pixel
 * (352 in a 5000x5000 world), and never fewer than ROCK_MIN_MASS.
 */
export const ROCK_DENSITY = 352 / (5000 * 5000);
export const ROCK_MIN_MASS = 4.4;
export const ROCK_SPAWN_INTERVAL = 0.4;
export const ROCK_SPAWN_CLEARANCE = 400;
export const BOUNCE_RESTITUTION = 0.85;

// --- Health pickups ---
export const PICKUP_RADIUS = 3;
/** Seconds a health pickup lasts; it blinks for the last PICKUP_BLINK seconds as a warning. */
export const PICKUP_LIFETIME = 10;
export const PICKUP_BLINK = 3;

// --- Networking ---
export const SHIP_SEND_INTERVAL = 1 / 20;
export const SNAPSHOT_INTERVAL = 5;
export const MAX_PLAYERS_PER_ROOM = 24;

// --- Flow ---
export const RESPAWN_DELAY = 1.2;
