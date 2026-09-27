// Every tunable number in the game lives here. Distances are pixels, speeds are pixels per second,
// times are seconds.

export const APP_ID = 'rockheal';

export const SCREEN_W = 480;
export const SCREEN_H = 270;

/** Reserved HUD bands: health circles along the top, kill count along the bottom. */
export const HUD_TOP = 11;
export const HUD_BOTTOM = 12;

export const WORLD_SIZE = 5000;

// --- Ships ---
export const SHIP_RADIUS = 4;
export const SHIP_ACCEL = 420;
export const SHIP_STRAFE_ACCEL = 340;
export const SHIP_REVERSE_ACCEL = 300;
export const SHIP_MAX_SPEED = 220;
/** Fraction of velocity kept per tick (60 Hz). */
export const SHIP_DRAG = 0.985;
export const SHIP_MASS = 1;
export const SHIP_ROTATIONS = 16;

export const START_HEALTH = 3;
export const MAX_HEALTH = 10;

// --- Bullets ---
export const BULLET_SPEED = 380;
export const BULLET_LIFE = 1.1;
export const FIRE_COOLDOWN = 0.14;

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
/** The host keeps the field topped up to this many full-size rocks' worth of mass. */
export const ROCK_TARGET_MASS = 320;
export const ROCK_SPAWN_INTERVAL = 0.4;
export const ROCK_SPAWN_CLEARANCE = 400;
export const BOUNCE_RESTITUTION = 0.85;

// --- Health pickups ---
export const PICKUP_RADIUS = 3;
export const PICKUP_LIFETIME = 90;

// --- Networking ---
export const SHIP_SEND_INTERVAL = 1 / 20;
export const SNAPSHOT_INTERVAL = 5;
export const MAX_PLAYERS_PER_ROOM = 24;

// --- Flow ---
export const RESPAWN_DELAY = 1.2;
