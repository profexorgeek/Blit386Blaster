import { BT, Rect2i, Vector2i } from 'blit386';

// Shapes the engine does not draw natively: circles and filled convex polygons.
// Scratch objects are reused so drawing hundreds of shapes a frame does not churn the garbage collector.

const p0 = new Vector2i(0, 0);
const p1 = new Vector2i(0, 0);
const span = new Rect2i(0, 0, 0, 1);

export function pixel(x: number, y: number, color: number): void {
    BT.drawPixel(Math.round(x), Math.round(y), color);
}

export function line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    p0.x = Math.round(x0);
    p0.y = Math.round(y0);
    p1.x = Math.round(x1);
    p1.y = Math.round(y1);
    BT.drawLine(p0, p1, color);
}

export function hspan(x0: number, x1: number, y: number, color: number): void {
    if (x1 < x0) {
        return;
    }

    span.x = x0;
    span.y = y;
    span.width = x1 - x0 + 1;
    span.height = 1;
    BT.drawRectFill(span, color);
}

export function rectFill(x: number, y: number, w: number, h: number, color: number): void {
    span.x = x;
    span.y = y;
    span.width = w;
    span.height = h;
    BT.drawRectFill(span, color);
}

/** Midpoint circle outline. */
export function circle(cx: number, cy: number, r: number, color: number): void {
    cx = Math.round(cx);
    cy = Math.round(cy);

    let x = r;
    let y = 0;
    let err = 1 - r;

    while (x >= y) {
        BT.drawPixel(cx + x, cy + y, color);
        BT.drawPixel(cx + y, cy + x, color);
        BT.drawPixel(cx - y, cy + x, color);
        BT.drawPixel(cx - x, cy + y, color);
        BT.drawPixel(cx - x, cy - y, color);
        BT.drawPixel(cx - y, cy - x, color);
        BT.drawPixel(cx + y, cy - x, color);
        BT.drawPixel(cx + x, cy - y, color);
        y++;

        if (err < 0) {
            err += 2 * y + 1;
        } else {
            x--;
            err += 2 * (y - x) + 1;
        }
    }
}

/** Filled circle drawn as horizontal spans; matches the outline from `circle()` at the same radius. */
export function circleFill(cx: number, cy: number, r: number, color: number): void {
    cx = Math.round(cx);
    cy = Math.round(cy);

    // (r + 0.5)^2 reproduces the midpoint outline's row widths, so no single-pixel bumps at the poles.
    const edge = (r + 0.5) * (r + 0.5);

    for (let dy = -r; dy <= r; dy++) {
        const half = Math.floor(Math.sqrt(edge - dy * dy));

        hspan(cx - half, cx + half, cy + dy, color);
    }
}

/**
 * Fills a convex polygon given as flat [x0, y0, x1, y1, ...] screen coordinates, then outlines it.
 * Pass `edge = 0` to skip the outline.
 */
export function convexPolygon(points: number[], fill: number, edge: number): void {
    const count = points.length / 2;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 1; i < points.length; i += 2) {
        minY = Math.min(minY, points[i]);
        maxY = Math.max(maxY, points[i]);
    }

    for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
        let left = Infinity;
        let right = -Infinity;

        for (let i = 0; i < count; i++) {
            const ax = points[i * 2];
            const ay = points[i * 2 + 1];
            const bx = points[((i + 1) % count) * 2];
            const by = points[((i + 1) % count) * 2 + 1];

            if ((ay <= y && by >= y) || (by <= y && ay >= y)) {
                const x = ay === by ? Math.min(ax, bx) : ax + ((y - ay) / (by - ay)) * (bx - ax);
                const x2 = ay === by ? Math.max(ax, bx) : x;

                left = Math.min(left, x);
                right = Math.max(right, x2);
            }
        }

        if (left <= right) {
            hspan(Math.round(left), Math.round(right), y, fill);
        }
    }

    if (edge) {
        for (let i = 0; i < count; i++) {
            const j = (i + 1) % count;

            line(points[i * 2], points[i * 2 + 1], points[j * 2], points[j * 2 + 1], edge);
        }
    }
}

/** Screen-space text via the engine's built-in font. */
export function text(x: number, y: number, color: number, message: string): void {
    p0.x = Math.round(x);
    p0.y = Math.round(y);
    BT.systemPrint(p0, color, message);
}

export function textWidth(message: string): number {
    return BT.systemPrintMeasure(message).x;
}

export function textCentered(cx: number, y: number, color: number, message: string): void {
    text(cx - Math.floor(textWidth(message) / 2), y, color, message);
}
