// Two-player smoke test: opens the game twice in headless Chrome against a local relay and checks that
// players see each other, bullets hurt, kills heal, and deaths reach the leaderboard.
//
// Usage (with the relay running: `cd ../relay && npm run dev`):
//   node scripts/multiplayer-smoke.mjs
//
// Screenshots land in screenshots/mp-*.png.

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const RELAY_HTTP = 'http://localhost:8787';

const server = await createServer({ logLevel: 'error', server: { port: 0, open: false } });

await server.listen();

const url = server.resolvedUrls.local[0];
let browser;

for (const channel of ['chrome', 'chromium', 'msedge']) {
    try {
        browser = await chromium.launch({ channel, headless: true });
        break;
    } catch {
        // try the next installed browser
    }
}

if (!browser) {
    throw new Error('No Chrome, Chromium, or Edge found for playwright-core.');
}

const failures = [];
const check = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);

    if (!ok) {
        failures.push(label);
    }
};

async function openPlayer(name) {
    const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await context.newPage();

    page.on('pageerror', (error) => failures.push(`${name} page error: ${error.message}`));
    await page.goto(`${url}?nosplash`);
    await page.waitForFunction(() => window.__game?.state().status === 'online', null, { timeout: 15000 });
    await page.waitForFunction(() => window.__game.game.session.hasWorld, null, { timeout: 15000 });

    return page;
}

const state = (page) => page.evaluate(() => window.__game.state());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spawn, then park the ship at (x, y) with no velocity and no spawn shield. */
async function spawnAt(page, x, y) {
    await page.evaluate(
        ([px, py]) => {
            const g = window.__game.game;

            g.clickQueued = true;
            window.__park = { x: px, y: py };
        },
        [x, y],
    );
    await sleep(100);
    await page.evaluate(() => {
        const g = window.__game.game;
        const { x, y } = window.__park;

        // Clear nearby rocks from this client's view so they do not shove the parked ship around.
        Object.assign(g.ship, { x, y, vx: 0, vy: 0 });
        g.prevX = x;
        g.prevY = y;
        g.shieldUntil = 0;
    });
}

/** Fire one bullet from `page`'s ship straight at (tx, ty). */
async function fireAt(page, tx, ty) {
    await page.evaluate(
        ([x, y]) => {
            const g = window.__game.game;
            const s = g.ship;
            const d = Math.hypot(x - s.x, y - s.y);
            const dx = (x - s.x) / d;
            const dy = (y - s.y) / d;

            g.session.fire(s.x + dx * 5, s.y + dy * 5, dx * 380, dy * 380);
        },
        [tx, ty],
    );
}

try {
    const a = await openPlayer('A');
    const b = await openPlayer('B');

    await sleep(500);

    const sa = await state(a);
    const sb = await state(b);

    check('both players online', sa.status === 'online' && sb.status === 'online');
    check('exactly one host', sa.isHost !== sb.isHost, `A host=${sa.isHost}, B host=${sb.isHost}`);
    check('B received the rock field', Math.abs(sa.rocks - sb.rocks) <= 2, `A=${sa.rocks} B=${sb.rocks}`);
    check('A sees B', sa.players.some((p) => p.id === sb.selfId));

    // Park both ships in a corner far from the rock field's usual traffic; keep firing lines clear.
    await spawnAt(a, 150, 150);
    await spawnAt(b, 190, 150);

    // Keep them parked (drift, rock nudges) while the test runs.
    const park = setInterval(() => {
        for (const [page, x, y] of [
            [a, 150, 150],
            [b, 190, 150],
        ]) {
            page.evaluate(
                ([px, py]) => {
                    const g = window.__game.game;

                    if (g.ship.alive) {
                        Object.assign(g.ship, { x: px, y: py, vx: 0, vy: 0 });
                    }
                },
                [x, y],
            ).catch(() => {});
        }
    }, 50);

    await sleep(400);

    const seen = (await state(a)).players.find((p) => p.id === sb.selfId);

    check('A sees B alive near (190,150)', seen?.alive && Math.abs(seen.x - 190) < 6, JSON.stringify(seen));

    await a.screenshot({ path: 'screenshots/mp-a-before.png' });

    await fireAt(a, 190, 150);
    await sleep(400);
    check('B lost one health', (await state(b)).ship.hp === 2);

    await fireAt(a, 190, 150);
    await sleep(400);
    await fireAt(a, 190, 150);
    await sleep(600);

    const afterKill = await state(a);
    const deadB = await state(b);

    check('B died', deadB.phase === 'dead' && !deadB.ship.alive);
    check('A credited with the kill', afterKill.ship.kills === 1, `kills=${afterKill.ship.kills}`);
    check('A healed to 4 by the kill', afterKill.ship.hp === 4, `hp=${afterKill.ship.hp}`);

    await a.screenshot({ path: 'screenshots/mp-a-after-kill.png' });
    await sleep(700);
    await b.screenshot({ path: 'screenshots/mp-b-dead.png' });

    // B respawns and kills A (4 hits), which submits A's single kill to the leaderboard.
    await spawnAt(b, 190, 150);
    await sleep(300);

    for (let i = 0; i < 4; i++) {
        await fireAt(b, 150, 150);
        await sleep(350);
    }

    await sleep(800);

    const deadA = await state(a);

    check('A died after 4 hits', deadA.phase === 'dead');

    const board = await (await fetch(`${RELAY_HTTP}/scores/rockheal`)).json();
    const nameA = await a.evaluate(() => window.__game.game.profile.name);

    check('A is on the leaderboard with 1 kill', board.some((row) => row.name === nameA && row.score === 1), JSON.stringify(board));

    await a.screenshot({ path: 'screenshots/mp-a-dead.png' });
    clearInterval(park);

    // A rock hit reported by the non-host is applied by the host and synced back to both.
    const hostPage = sa.isHost ? a : b;
    const otherPage = sa.isHost ? b : a;
    const rockId = await otherPage.evaluate(() => {
        const session = window.__game.game.session;
        const rock = [...session.rocks.values()].find((r) => r.hp === 3);
        const bullet = { id: 'test', owner: session.selfId, x0: 0, y0: 0, vx: 1, vy: 0, t0: 0, dead: false };

        session.reportRockHit(bullet, rock, 0, 0);

        return rock.id;
    });

    await sleep(400);

    const rockHp = (page) => page.evaluate((id) => window.__game.game.session.rocks.get(id)?.hp, rockId);

    check('non-host rock hit applied by host', (await rockHp(hostPage)) === 2 && (await rockHp(otherPage)) === 2);

    // Host hand-over: close the host, and the other player should take over the field.

    await hostPage.context().close();
    await sleep(800);

    const other = await state(otherPage);

    check('remaining player became host', other.isHost && other.players.length === 0);
} finally {
    await browser.close();
    await server.close();
}

if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
}

console.log('\nAll multiplayer checks passed.');
