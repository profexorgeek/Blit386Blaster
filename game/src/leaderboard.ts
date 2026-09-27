import type { ScoreEntry } from '../../relay/src/protocol.ts';

import { APP_ID } from './constants.ts';

// Talks to the relay's scoreboard over plain HTTP. Scores expire on the relay five minutes after they are set.

export class Leaderboard {
    entries: ScoreEntry[] = [];
    isLoaded = false;

    private readonly endpoint: string;

    /** `relayUrl` is the WebSocket base (ws:// or wss://); the scoreboard lives on the same host over http(s). */
    constructor(relayUrl: string) {
        const http = relayUrl.replace(/^ws/, 'http').replace(/\/+$/, '');

        this.endpoint = `${http}/scores/${APP_ID}`;
    }

    async refresh(): Promise<void> {
        try {
            const response = await fetch(this.endpoint);

            if (response.ok) {
                this.entries = (await response.json()) as ScoreEntry[];
                this.isLoaded = true;
            }
        } catch {
            // Offline: keep whatever we had.
        }
    }

    async submit(player: string, name: string, score: number): Promise<void> {
        try {
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player, name, score }),
            });

            if (response.ok) {
                this.entries = (await response.json()) as ScoreEntry[];
                this.isLoaded = true;
            }
        } catch {
            // Offline: the score just does not make the board.
        }
    }
}
