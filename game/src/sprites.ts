import { BT, Rect2i, SpriteSheet, Vector2i } from 'blit386';

import { SHIP_ROTATIONS } from './constants.ts';

// The engine cannot rotate sprites, so the ship is rasterized from a polygon at startup into one 8x8 frame per
// direction. Pixels store 1 (body), 2 (shade) or 3 (highlight); a palette offset picks the player's colors.

const SIZE = 8;

/** The ship outline pointing right (+x), centered on (0, 0), in pixels. A dart with a notched tail. */
const HULL: [number, number][] = [
    [4.2, 0],
    [-3.6, -3.6],
    [-1.8, 0],
    [-3.6, 3.6],
];

let sheet: SpriteSheet;
const src = new Rect2i(0, 0, SIZE, SIZE);
const dest = new Vector2i(0, 0);

export function buildShipSprites(): void {
    const width = SIZE * SHIP_ROTATIONS;
    const pixels = new Uint8Array(width * SIZE);

    for (let frame = 0; frame < SHIP_ROTATIONS; frame++) {
        const angle = (frame / SHIP_ROTATIONS) * Math.PI * 2;
        const cos = Math.cos(-angle);
        const sin = Math.sin(-angle);

        for (let py = 0; py < SIZE; py++) {
            for (let px = 0; px < SIZE; px++) {
                // Rotate the pixel center back into the ship's own frame and test it against the hull.
                const x = px + 0.5 - SIZE / 2;
                const y = py + 0.5 - SIZE / 2;
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

                pixels[py * width + frame * SIZE + px] = index;
            }
        }
    }

    sheet = SpriteSheet.fromIndexedPixels(width, SIZE, pixels);
}

/** Draws the ship centered on screen position (x, y), facing `angle` radians, in the given palette block. */
export function drawShip(x: number, y: number, angle: number, colorBlock: number): void {
    const turn = angle / (Math.PI * 2);
    const frame = (((Math.round(turn * SHIP_ROTATIONS) % SHIP_ROTATIONS) + SHIP_ROTATIONS) % SHIP_ROTATIONS);

    src.x = frame * SIZE;
    dest.x = Math.round(x) - SIZE / 2;
    dest.y = Math.round(y) - SIZE / 2;
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
