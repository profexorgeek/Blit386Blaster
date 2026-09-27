import { randomShipHue } from './palette.ts';

// The player's identity, kept in localStorage so it survives reloads: a stable id for the leaderboard, a random
// name and ship color, and their best kill count ever.

export interface Profile {
    id: string;
    name: string;
    hue: number;
    best: number;
}

/**
 * `?profile=2` in the address keeps a separate identity under its own key, so two tabs in one browser can play as
 * two different players.
 */
const PROFILE_SLOT = new URLSearchParams(window.location.search).get('profile');
const KEY = PROFILE_SLOT ? `rockheal.profile.${PROFILE_SLOT}` : 'rockheal.profile';

const ADJECTIVES = [
    'Swift', 'Rusty', 'Quiet', 'Lucky', 'Brave', 'Cosmic', 'Dusty', 'Frosty', 'Gentle', 'Hasty', 'Jolly', 'Lunar',
    'Mellow', 'Nimble', 'Plucky', 'Rogue', 'Sly', 'Solar', 'Stormy', 'Tiny', 'Wild', 'Zesty', 'Bold', 'Clever',
];
const NOUNS = [
    'Comet', 'Pigeon', 'Otter', 'Nebula', 'Falcon', 'Badger', 'Quasar', 'Pebble', 'Walrus', 'Meteor', 'Heron',
    'Pulsar', 'Gecko', 'Rocket', 'Lynx', 'Moth', 'Orbit', 'Ferret', 'Beacon', 'Marmot', 'Photon', 'Raven', 'Yak',
];

export function loadProfile(): Profile {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Profile> | null;

        if (saved && typeof saved.id === 'string' && typeof saved.name === 'string' && typeof saved.hue === 'number') {
            return { id: saved.id, name: saved.name, hue: saved.hue, best: Number(saved.best) || 0 };
        }
    } catch {
        // Storage blocked or corrupted: fall through to a fresh profile.
    }

    const fresh = { id: randomId(), name: randomName(), hue: randomShipHue(), best: 0 };

    saveProfile(fresh);

    return fresh;
}

export function saveProfile(profile: Profile): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(profile));
    } catch {
        // Private windows can refuse storage; the game still works, it just forgets.
    }
}

export function randomName(): string {
    const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];

    return `${pick(ADJECTIVES)}${pick(NOUNS)}`;
}

function randomId(): string {
    const bytes = new Uint8Array(12);

    crypto.getRandomValues(bytes);

    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
