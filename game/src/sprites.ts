import { BT, Rect2i, SpriteSheet, Vector2i } from 'blit386';

import { SHIP_ROTATIONS } from './constants.ts';

// The engine cannot rotate sprites, so the ship is rasterized from a polygon at startup into one frame per
// direction, once per size phase (8x8, 16x16, 24x24). Each size is drawn fresh rather than pixel-doubled, so big
// ships stay crisp, and the bigger sizes get more angles so their turning looks as smooth as the small one.
// Pixels store 1 (body), 2 (shade) or 3 (highlight); a palette offset picks the player's colors.

const BASE = 8;

/** The ship outline pointing right (+x), centered on (0, 0), in 8x8 pixels. A dart with a notched tail. */
const HULL: [number, number][] = [
    [4.2, 0],
    [-3.6, -3.6],
    [-1.8, 0],
    [-3.6, 3.6],
];

interface ShipSheet {
    sheet: SpriteSheet;
    size: number;
    rotations: number;
}

/** Indexed by scale: 1, 2 or 3. */
const sheets: ShipSheet[] = [];
const src = new Rect2i(0, 0, BASE, BASE);
const dest = new Vector2i(0, 0);

export function buildShipSprites(): void {
    for (let scale = 1; scale <= 3; scale++) {
        sheets[scale] = buildSheet(scale, scale === 1 ? SHIP_ROTATIONS : SHIP_ROTATIONS * 2);
    }
}

function buildSheet(scale: number, rotations: number): ShipSheet {
    const size = BASE * scale;
    const width = size * rotations;
    const pixels = new Uint8Array(width * size);

    for (let frame = 0; frame < rotations; frame++) {
        const angle = (frame / rotations) * Math.PI * 2;
        const cos = Math.cos(-angle);
        const sin = Math.sin(-angle);

        for (let py = 0; py < size; py++) {
            for (let px = 0; px < size; px++) {
                // Rotate the pixel center back into the ship's own frame (in 8x8 units) and test it against the hull.
                const x = (px + 0.5 - size / 2) / scale;
                const y = (py + 0.5 - size / 2) / scale;
                const lx = x * cos - y * sin;
                const ly = x * sin + y * cos;

                if (!insidePolygon(lx, ly, HULL)) {
                    continue;
                }

                let index = 1;

                if (lx > 0.2 && lx < 2.6 && Math.abs(ly) < 0.9) {
                    index = 3; // cockpit
                } else if (lx < -1.6) {
                    index = 2; // tail fins
                }

                pixels[py * width + frame * size + px] = index;
            }
        }
    }

    return { sheet: SpriteSheet.fromIndexedPixels(width, size, pixels), size, rotations };
}

/**
 * Draws the ship centered on screen position (x, y), facing `angle` radians, in the given palette block, at
 * `scale` 1, 2 or 3.
 */
export function drawShip(x: number, y: number, angle: number, colorBlock: number, scale = 1): void {
    const { sheet, size, rotations } = sheets[scale] ?? sheets[1];
    const turn = angle / (Math.PI * 2);
    const frame = ((Math.round(turn * rotations) % rotations) + rotations) % rotations;

    src.x = frame * size;
    src.width = size;
    src.height = size;
    dest.x = Math.round(x) - size / 2;
    dest.y = Math.round(y) - size / 2;
    BT.drawSprite(sheet, src, dest, colorBlock - 1);
}

function insidePolygon(x: number, y: number, polygon: [number, number][]): boolean {
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];

        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }

    return inside;
}
