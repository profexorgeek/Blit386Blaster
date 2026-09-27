import { BT, Color32, type Palette } from 'blit386';

// Fixed palette slots. Yellow (C.YELLOW) is reserved for bullets and the world boundary - nothing else uses it.
export const C = {
    SPACE: 1,
    PLANET_A: 2,
    PLANET_B: 3,
    STAR_DIM: 4,
    STAR_MID: 5,
    STAR_BRIGHT: 6,
    YELLOW: 7,
    RED: 8,
    ROCK_FILL: 9,
    ROCK_EDGE: 10,
    ROCK_FLASH: 11,
    HUD_BG: 12,
    HUD_LINE: 13,
    TEXT: 14,
    TEXT_DIM: 15,
} as const;

/**
 * Each player gets a block of consecutive slots: [body, shade, highlight, spare].
 * Ship sprites store indices 1..3, so drawing with `paletteOffset = block - 1` paints them in that player's colors.
 */
const PLAYER_BASE = 32;
const PLAYER_BLOCK = 4;
const PLAYER_BLOCKS = 48;

let palette: Palette;
const freeBlocks: number[] = [];

export function createPalette(): void {
    palette = BT.paletteCreate(256);

    const rgb = (slot: number, r: number, g: number, b: number) => palette.set(slot, new Color32(r, g, b));

    rgb(C.SPACE, 7, 8, 13);
    rgb(C.PLANET_A, 30, 31, 36);
    rgb(C.PLANET_B, 22, 23, 27);
    rgb(C.STAR_DIM, 52, 56, 74);
    rgb(C.STAR_MID, 110, 116, 142);
    rgb(C.STAR_BRIGHT, 205, 212, 235);
    rgb(C.YELLOW, 255, 226, 0);
    rgb(C.RED, 232, 38, 52);
    rgb(C.ROCK_FILL, 88, 80, 74);
    rgb(C.ROCK_EDGE, 146, 134, 122);
    rgb(C.ROCK_FLASH, 222, 218, 210);
    rgb(C.HUD_BG, 14, 15, 22);
    rgb(C.HUD_LINE, 40, 42, 56);
    rgb(C.TEXT, 228, 230, 240);
    rgb(C.TEXT_DIM, 120, 124, 142);

    for (let i = PLAYER_BLOCKS - 1; i >= 0; i--) {
        freeBlocks.push(PLAYER_BASE + i * PLAYER_BLOCK);
    }

    BT.paletteSet(palette);
}

/** Reserves a palette block for a ship color and returns its first slot (the body color). */
export function allocPlayerColor(hue: number): number {
    const block = freeBlocks.pop() ?? PLAYER_BASE;

    setPlayerColor(block, hue);

    return block;
}

export function setPlayerColor(block: number, hue: number): void {
    palette.set(block, hslColor(hue, 0.8, 0.6));
    palette.set(block + 1, hslColor(hue, 0.7, 0.35));
    palette.set(block + 2, hslColor(hue, 0.5, 0.88));
}

export function freePlayerColor(block: number): void {
    if (!freeBlocks.includes(block)) {
        freeBlocks.push(block);
    }
}

/**
 * A random ship hue that stays clear of yellow (bullets and the boundary) and of red (health and the crosshair).
 */
export function randomShipHue(): number {
    for (;;) {
        const hue = Math.floor(Math.random() * 360);

        if ((hue >= 18 && hue <= 36) || (hue >= 80 && hue <= 330)) {
            return hue;
        }
    }
}

function hslColor(hue: number, s: number, l: number): Color32 {
    const k = (n: number) => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));

    return new Color32(Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255));
}
