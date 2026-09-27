import { SCREEN_H, SCREEN_W } from './constants.ts';
import { circleFill, pixel } from './draw.ts';
import { C } from './palette.ts';

// An endless parallax background. Nothing is stored: each layer is a grid of cells, and a hash of the cell
// coordinates decides what lives in it, so the same patch of sky always looks the same.

interface StarLayer {
    parallax: number;
    cell: number;
    perCell: number;
    color: number;
}

const FAR_STARS: StarLayer = { parallax: 0.12, cell: 70, perCell: 2, color: C.STAR_DIM };
const NEAR_STARS: StarLayer[] = [
    { parallax: 0.4, cell: 90, perCell: 1, color: C.STAR_MID },
    { parallax: 0.7, cell: 140, perCell: 1, color: C.STAR_BRIGHT },
];

/** Planets sit between the far stars and the near ones. */
const PLANETS = { parallax: 0.22, cell: 420, chance: 0.22, minRadius: 10, maxRadius: 44 };

export function drawStarfield(cameraX: number, cameraY: number): void {
    drawStars(FAR_STARS, cameraX, cameraY, 1);
    drawPlanets(cameraX, cameraY);

    for (let i = 0; i < NEAR_STARS.length; i++) {
        drawStars(NEAR_STARS[i], cameraX, cameraY, i + 2);
    }
}

function drawStars(layer: StarLayer, cameraX: number, cameraY: number, salt: number): void {
    const ox = cameraX * layer.parallax;
    const oy = cameraY * layer.parallax;
    const x0 = Math.floor(ox / layer.cell);
    const y0 = Math.floor(oy / layer.cell);
    const x1 = Math.floor((ox + SCREEN_W) / layer.cell);
    const y1 = Math.floor((oy + SCREEN_H) / layer.cell);

    for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
            for (let n = 0; n < layer.perCell; n++) {
                const h = hash(cx, cy, salt * 16 + n);
                const sx = cx * layer.cell + (h & 0xffff) / 0x10000 * layer.cell - ox;
                const sy = cy * layer.cell + (h >>> 16) / 0x10000 * layer.cell - oy;

                pixel(sx, sy, layer.color);
            }
        }
    }
}

function drawPlanets(cameraX: number, cameraY: number): void {
    const { parallax, cell, chance, minRadius, maxRadius } = PLANETS;
    const ox = cameraX * parallax;
    const oy = cameraY * parallax;
    // Widen the cell range by the largest radius so planets straddling the screen edge still draw.
    const x0 = Math.floor((ox - maxRadius) / cell);
    const y0 = Math.floor((oy - maxRadius) / cell);
    const x1 = Math.floor((ox + SCREEN_W + maxRadius) / cell);
    const y1 = Math.floor((oy + SCREEN_H + maxRadius) / cell);

    for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
            const h = hash(cx, cy, 99);

            if ((h & 0xff) / 0x100 >= chance) {
                continue;
            }

            const h2 = hash(cx, cy, 101);
            const radius = minRadius + Math.floor(((h2 & 0xff) / 0x100) * (maxRadius - minRadius));
            const margin = maxRadius;
            const px = cx * cell + margin + (((h2 >>> 8) & 0xfff) / 0x1000) * (cell - margin * 2) - ox;
            const py = cy * cell + margin + (((h2 >>> 20) & 0xfff) / 0x1000) * (cell - margin * 2) - oy;

            circleFill(px, py, radius, (h >>> 8) & 1 ? C.PLANET_A : C.PLANET_B);
        }
    }
}

/** Small integer hash (a few rounds of multiply-xorshift) of a cell coordinate and a salt. */
function hash(x: number, y: number, salt: number): number {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);

    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);

    return (h ^ (h >>> 16)) >>> 0;
}
