import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScoreboardConfig } from './config.ts';
import type { ScoreEntry, ScoreSubmission } from './protocol.ts';

interface StoredEntry extends ScoreEntry {
    player: string;
}

/** Hard cap on stored rows, so a flood of fake players cannot grow the file without bound. */
const MAX_STORED = 1000;

/**
 * A leaderboard where every score expires `ttlSeconds` after it was set, so the board stays fresh.
 * Each player holds at most one row: a new score replaces theirs only if it beats it (or theirs expired).
 */
export class Scoreboard {
    private entries = new Map<string, StoredEntry>();
    private saveTimer: NodeJS.Timeout | null = null;
    private readonly file: string;
    private readonly config: ScoreboardConfig;

    constructor(app: string, config: ScoreboardConfig, dataDir: string) {
        this.config = config;
        this.file = join(dataDir, `scores-${app}.json`);
        mkdirSync(dataDir, { recursive: true });
        this.load();
    }

    top(now = Date.now()): ScoreEntry[] {
        this.prune(now);

        return [...this.entries.values()]
            .sort((a, b) => b.score - a.score || a.at - b.at)
            .slice(0, this.config.keep)
            .map(({ name, score, at }) => ({ name, score, at }));
    }

    submit(submission: ScoreSubmission, now = Date.now()): ScoreEntry[] {
        this.prune(now);

        const existing = this.entries.get(submission.player);

        if (!existing || submission.score > existing.score) {
            this.entries.set(submission.player, { ...submission, at: now });

            if (this.entries.size > MAX_STORED) {
                const lowest = [...this.entries.values()].sort((a, b) => a.score - b.score || a.at - b.at)[0];
                this.entries.delete(lowest.player);
            }

            this.scheduleSave();
        } else if (existing.name !== submission.name) {
            existing.name = submission.name;
            this.scheduleSave();
        }

        return this.top(now);
    }

    /** Writes any pending change right away. Call on shutdown. */
    flush(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            this.save();
        }
    }

    private prune(now: number): void {
        const cutoff = now - this.config.ttlSeconds * 1000;

        for (const [player, entry] of this.entries) {
            if (entry.at < cutoff) {
                this.entries.delete(player);
            }
        }
    }

    private load(): void {
        try {
            const rows = JSON.parse(readFileSync(this.file, 'utf8')) as StoredEntry[];

            for (const row of rows) {
                this.entries.set(row.player, row);
            }
        } catch {
            // No file yet, or it is unreadable: start empty.
        }
    }

    private scheduleSave(): void {
        this.saveTimer ??= setTimeout(() => {
            this.saveTimer = null;
            this.save();
        }, 1000);
    }

    private save(): void {
        // Write to a temp file and rename, so a crash mid-write never leaves a half-written board.
        const temp = `${this.file}.tmp`;

        writeFileSync(temp, JSON.stringify([...this.entries.values()]));
        renameSync(temp, this.file);
    }
}

export function parseSubmission(body: unknown): ScoreSubmission | null {
    if (typeof body !== 'object' || body === null) {
        return null;
    }

    const { player, name, score } = body as Record<string, unknown>;

    if (typeof player !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(player)) {
        return null;
    }

    if (typeof name !== 'string') {
        return null;
    }

    // Printable ASCII only, trimmed and capped, so names render in any bitmap font.
    const cleanName = name.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 24);

    if (cleanName.length === 0) {
        return null;
    }

    if (typeof score !== 'number' || !Number.isSafeInteger(score) || score < 0 || score > 1_000_000_000) {
        return null;
    }

    return { player, name: cleanName, score };
}
