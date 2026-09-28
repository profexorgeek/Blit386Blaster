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
const ROOM = Date.now().toString(36);

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
    // A room of our own, so a game you have open in another window does not join the test.
    await page.goto(`${url}?nosplash&room=smoke-${ROOM}`);
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

    const sizes = await Promise.all([a, b].map((page) => page.evaluate(() => window.__game.state().worldSize)));

    check('world grew to 750 for two players, on both', sizes[0] === 750 && sizes[1] === 750, sizes.join(' / '));

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

    // Combat checks below need clear firing lines, and a rock drifting through one makes them flaky. The host
    // empties the field, stops spawning, and sends everyone the empty world.
    await hostPage.evaluate(() => {
        const session = window.__game.game.session;

        session.spawnRock = () => null;
        session.rocks.clear();
        session.send(session.worldSnapshot());
    });
    await sleep(300);
    check('rock field cleared for combat', (await state(otherPage)).rocks === 0);

    // Park both ships in a corner.
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

    // Kills make a ship bigger and easier to hit: a shot passing 10 px from B's center misses a fresh ship
    // (radius 4) but hits one with 10 kills (radius 12).
    const grazeB = () => a.evaluate(() => window.__game.game.session.fire(100, 160, 380, 0));

    await grazeB();
    await sleep(400);
    check('graze misses a small ship', (await state(b)).ship.hp === 3);

    await b.evaluate(() => {
        window.__game.game.ship.kills = 10;
    });
    await grazeB();
    await sleep(400);

    const big = await state(b);

    check('graze hits a 3x ship', big.ship.hp === 2, `hp=${big.ship.hp}`);
    await b.evaluate(() => Object.assign(window.__game.game.ship, { kills: 0, hp: 3 }));

    await fireAt(a, 190, 150);
    await sleep(400);
    check('B lost one health', (await state(b)).ship.hp === 2);

    // A bullet whose message shows up late (fired 0.4 s ago from 90 px away) is already past B when B first hears
    // of it. B must still test the stretch it missed.
    await a.evaluate(() => {
        const session = window.__game.game.session;

        session.send({ k: 'fire', id: 'late-1', x: 100, y: 150, vx: 380, vy: 0, ts: session.now() - 0.4 });
    });
    await sleep(300);
    check('late-arriving bullet still hits', (await state(b)).ship.hp === 1);

    await fireAt(a, 190, 150);
    await sleep(600);

    const afterKill = await state(a);
    const deadB = await state(b);

    check('B died', deadB.phase === 'dead' && !deadB.ship.alive);
    check('A credited with the kill', afterKill.ship.kills === 1, `kills=${afterKill.ship.kills}`);
    check(
        'the kill added a filled health circle (4 of 4)',
        afterKill.ship.hp === 4 && afterKill.ship.maxHp === 4,
        `hp=${afterKill.ship.hp} max=${afterKill.ship.maxHp}`,
    );

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

    const board = await (await fetch(`${RELAY_HTTP}/scores/blit386blaster`)).json();
    const nameA = await a.evaluate(() => window.__game.game.profile.name);

    check('A is on the leaderboard with 1 kill', board.some((row) => row.name === nameA && row.score === 1), JSON.stringify(board));

    await a.screenshot({ path: 'screenshots/mp-a-dead.png' });
    clearInterval(park);

    // Host hand-over: close the host, and the other player should take over the field.

    await hostPage.context().close();
    await sleep(800);

    const other = await state(otherPage);

    check('remaining player became host', other.isHost && other.players.length === 0);
    check('world waits before shrinking', other.worldSize === 750, `size=${other.worldSize}`);

    await sleep(10_500);
    check('world shrank back to 500 for one player', (await state(otherPage)).worldSize === 500);
} finally {
    await browser.close();
    await server.close();
}

if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
}

console.log('\nAll multiplayer checks passed.');
