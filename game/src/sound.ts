import { AudioClip, BT, type SoundRef } from 'blit386';

// Every sound is synthesized at startup (no audio files), then played through the engine's sfx bus.
// Browsers keep the game silent until the first click or key press; the title screen's "click to fly" takes care
// of that.

const MUTE_KEY = 'blit386blaster.muted';
/** Hard bounces are louder; below this closing speed (px/s) a touch makes no sound at all. */
const BOUNCE_MIN_SPEED = 30;
const BOUNCE_COOLDOWN_MS = 90;
/**
 * The engine mixes 16 voices at once. Other ships' engine loops get at most this many (the loudest), so shots and
 * explosions always have room.
 */
const MAX_REMOTE_ENGINES = 3;
const LOCAL_THRUST_VOLUME = 0.1;

/**
 * When all 16 voices are busy, the engine drops the lowest priority first. The sounds that matter for play (hits,
 * explosions, shots) outrank the ambience (bounces, rock hits and breaks).
 */
const PRIORITY_SUBTLE = 0;
const PRIORITY_SHOT = 5;
const PRIORITY_HIT = 8;
const PRIORITY_EXPLOSION = 10;

/** A sound source somewhere in the world, already placed relative to the listener. */
export interface PlacedSource {
    id: string;
    /** 0 (out of earshot) to 1 (right here). */
    volume: number;
    /** -1 left to 1 right. */
    pan: number;
}

export class Sounds {
    private thrustRef: SoundRef | null = null;
    private readonly remoteEngines = new Map<string, SoundRef>();
    private lastBounceMs = 0;

    private constructor(
        private readonly thrustClip: AudioClip,
        private readonly shootClip: AudioClip,
        private readonly bounceClip: AudioClip,
        private readonly explodeClip: AudioClip,
        private readonly chimeLowClip: AudioClip,
        private readonly chimeHighClip: AudioClip,
        private readonly hurtClip: AudioClip,
        private readonly rockHitClip: AudioClip,
        private readonly rockBreakClip: AudioClip,
    ) {}

    static async create(): Promise<Sounds> {
        const [thrust, shoot, bounce, explode, chimeLow, chimeHigh, hurt, rockHit, rockBreak] = await Promise.all([
            // A second of flat noise with no envelope, so it loops without a click at the seam.
            AudioClip.synth({
                waveform: 'noise',
                frequency: 200,
                duration: 1,
                envelope: { attack: 0, decay: 0, sustain: 1, release: 0 },
                volume: 1,
                seed: 7,
            }),
            // The classic "pew": a thin square wave diving in pitch.
            AudioClip.synth({
                waveform: 'square',
                frequency: 1100,
                duration: 0.14,
                pitchSweep: { toFrequency: 180 },
                dutyCycle: 0.25,
                envelope: { attack: 0, decay: 0.12, sustain: 0, release: 0.02 },
                volume: 0.5,
                seed: 1,
            }),
            // A soft, low "boing": a triangle wave sliding up, with a little wobble.
            AudioClip.synth({
                waveform: 'triangle',
                frequency: 80,
                duration: 0.16,
                pitchSweep: { toFrequency: 240 },
                vibrato: { rate: 24, depth: 15 },
                envelope: { attack: 0, decay: 0.14, sustain: 0, release: 0.02 },
                volume: 0.9,
                seed: 2,
            }),
            AudioClip.synth(BT.synthPreset.explosion(3)),
            // A happy two-note pickup chime (B5, then a longer E6), in the spirit of an arcade coin.
            AudioClip.synth({
                waveform: 'square',
                frequency: 988,
                duration: 0.08,
                dutyCycle: 0.5,
                envelope: { attack: 0, decay: 0, sustain: 1, release: 0.01 },
                volume: 0.5,
                seed: 3,
            }),
            AudioClip.synth({
                waveform: 'square',
                frequency: 1319,
                duration: 0.32,
                dutyCycle: 0.5,
                envelope: { attack: 0, decay: 0.3, sustain: 0, release: 0.02 },
                volume: 0.5,
                seed: 4,
            }),
            // Ship hit: a harsh, gritty square wave dropping fast. Meant to cut through everything else.
            AudioClip.synth({
                waveform: 'square',
                frequency: 520,
                duration: 0.2,
                pitchSweep: { toFrequency: 90 },
                noiseMix: 0.45,
                dutyCycle: 0.4,
                envelope: { attack: 0, decay: 0.18, sustain: 0, release: 0.02 },
                volume: 0.9,
                seed: 5,
            }),
            // Rock hit: a short, dull low "tock".
            AudioClip.synth({
                waveform: 'triangle',
                frequency: 140,
                duration: 0.07,
                pitchSweep: { toFrequency: 70 },
                noiseMix: 0.35,
                envelope: { attack: 0, decay: 0.06, sustain: 0, release: 0.01 },
                volume: 0.9,
                seed: 6,
            }),
            // Rock break: a low gravelly crunch with a rumble under it.
            AudioClip.synth({
                waveform: 'triangle',
                frequency: 110,
                duration: 0.4,
                pitchSweep: { toFrequency: 40 },
                noiseMix: 0.7,
                envelope: { attack: 0, decay: 0.38, sustain: 0, release: 0.02 },
                volume: 0.9,
                seed: 8,
            }),
        ]);

        const sounds = new Sounds(thrust, shoot, bounce, explode, chimeLow, chimeHigh, hurt, rockHit, rockBreak);

        sounds.setMuted(loadMuted());

        return sounds;
    }

    get isMuted(): boolean {
        return BT.isAudioMuted('sfx');
    }

    toggleMuted(): void {
        this.setMuted(!this.isMuted);
    }

    /** Starts or stops the quiet engine hiss. Call every tick with whether the ship is thrusting. */
    setThrusting(on: boolean): void {
        if (on && this.thrustRef === null) {
            // Played slowed down, the hiss turns into a darker rumble.
            this.thrustRef = BT.soundPlay(this.thrustClip, {
                loop: true,
                volume: LOCAL_THRUST_VOLUME,
                pitch: 0.55,
                fadeInMs: 60,
            });
        } else if (!on && this.thrustRef !== null) {
            BT.soundStop(this.thrustRef, { fadeOutMs: 120 });
            this.thrustRef = null;
        }
    }

    /**
     * Keeps a looping engine hiss running for each of the loudest thrusting ships nearby, following their volume
     * and pan, and fades out the rest. Call a few times a second with every thrusting ship in earshot.
     */
    updateRemoteEngines(sources: PlacedSource[]): void {
        const loudest = sources
            .filter((source) => source.volume > 0.03)
            .sort((a, b) => b.volume - a.volume)
            .slice(0, MAX_REMOTE_ENGINES);
        const keep = new Set(loudest.map((source) => source.id));

        for (const [id, ref] of this.remoteEngines) {
            if (!keep.has(id)) {
                BT.soundStop(ref, { fadeOutMs: 200 });
                this.remoteEngines.delete(id);
            }
        }

        for (const source of loudest) {
            // A touch quieter than your own engine, even up close, so yours stays the one you notice.
            const volume = LOCAL_THRUST_VOLUME * 0.8 * source.volume;
            const ref = this.remoteEngines.get(source.id);

            if (ref) {
                BT.soundVolumeSet(ref, volume, { fadeMs: 80 });
                BT.soundPanSet(ref, source.pan, { fadeMs: 80 });
            } else {
                this.remoteEngines.set(
                    source.id,
                    BT.soundPlay(this.thrustClip, {
                        loop: true,
                        volume,
                        pan: source.pan,
                        // Each ship hums at its own pitch, so two engines do not blur into one.
                        pitch: 0.45 + (hashId(source.id) % 20) / 100,
                        fadeInMs: 120,
                    }),
                );
            }
        }
    }

    /** Silences every engine loop, yours and everyone else's (e.g. when the tab is hidden). */
    stopAllEngines(): void {
        this.setThrusting(false);
        this.updateRemoteEngines([]);
    }

    shoot(volume = 1, pan = 0): void {
        BT.soundPlay(this.shootClip, {
            volume: 0.2 * volume,
            pan,
            pitch: 0.95 + Math.random() * 0.1,
            priority: PRIORITY_SHOT,
        });
    }

    /** `speed` is how hard the ship hit (closing speed in px/s). */
    bounce(speed: number): void {
        const now = performance.now();

        if (speed < BOUNCE_MIN_SPEED || now - this.lastBounceMs < BOUNCE_COOLDOWN_MS) {
            return;
        }

        this.lastBounceMs = now;
        BT.soundPlay(this.bounceClip, {
            volume: Math.min(0.2, 0.06 + speed / 1500),
            pitch: 0.9 + Math.random() * 0.2,
            priority: PRIORITY_SUBTLE,
        });
    }

    explode(volume = 1, pan = 0): void {
        BT.soundPlay(this.explodeClip, { volume: 0.8 * volume, pan, priority: PRIORITY_EXPLOSION });
    }

    /** A ship took a hit. Loud: this is the sound that tells you a shot landed. */
    hurt(volume = 1, pan = 0): void {
        BT.soundPlay(this.hurtClip, { volume: 0.45 * volume, pan, priority: PRIORITY_HIT });
    }

    /** A bullet struck a rock. Subtle. */
    rockHit(volume = 1, pan = 0): void {
        BT.soundPlay(this.rockHitClip, {
            volume: 0.1 * volume,
            pan,
            pitch: 0.85 + Math.random() * 0.3,
            priority: PRIORITY_SUBTLE,
        });
    }

    /** A rock broke apart; bigger rocks sound deeper and a little louder. Still subtle. */
    rockBreak(size: number, volume = 1, pan = 0): void {
        BT.soundPlay(this.rockBreakClip, {
            volume: (0.08 + size * 0.03) * volume,
            pan,
            pitch: 1.25 - size * 0.15 + Math.random() * 0.1,
            priority: PRIORITY_SUBTLE,
        });
    }

    pickup(): void {
        BT.soundPlay(this.chimeLowClip, { volume: 0.3 });
        window.setTimeout(() => BT.soundPlay(this.chimeHighClip, { volume: 0.3 }), 75);
    }

    private setMuted(muted: boolean): void {
        BT.audioMuteSet('sfx', muted);

        try {
            localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
        } catch {
            // Storage blocked: the setting just does not stick.
        }
    }
}

function hashId(id: string): number {
    let hash = 0;

    for (let i = 0; i < id.length; i++) {
        hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    }

    return hash;
}

function loadMuted(): boolean {
    try {
        return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
        return false;
    }
}
