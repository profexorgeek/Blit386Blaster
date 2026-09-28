import { AudioClip, BT, type SoundRef } from 'blit386';

// Every sound is synthesized at startup (no audio files), then played through the engine's sfx bus.
// Browsers keep the game silent until the first click or key press; the title screen's "click to fly" takes care
// of that.

const MUTE_KEY = 'blit386blaster.muted';
/** Hard bounces are louder; below this closing speed (px/s) a touch makes no sound at all. */
const BOUNCE_MIN_SPEED = 30;
const BOUNCE_COOLDOWN_MS = 90;

export class Sounds {
    private thrustRef: SoundRef | null = null;
    private lastBounceMs = 0;

    private constructor(
        private readonly thrustClip: AudioClip,
        private readonly shootClip: AudioClip,
        private readonly bounceClip: AudioClip,
        private readonly explodeClip: AudioClip,
        private readonly chimeLowClip: AudioClip,
        private readonly chimeHighClip: AudioClip,
    ) {}

    static async create(): Promise<Sounds> {
        const [thrust, shoot, bounce, explode, chimeLow, chimeHigh] = await Promise.all([
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
            // A springy "boing": a triangle wave sliding up, with a little wobble.
            AudioClip.synth({
                waveform: 'triangle',
                frequency: 160,
                duration: 0.16,
                pitchSweep: { toFrequency: 620 },
                vibrato: { rate: 30, depth: 40 },
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
        ]);

        const sounds = new Sounds(thrust, shoot, bounce, explode, chimeLow, chimeHigh);

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
            this.thrustRef = BT.soundPlay(this.thrustClip, { loop: true, volume: 0.1, pitch: 0.55, fadeInMs: 60 });
        } else if (!on && this.thrustRef !== null) {
            BT.soundStop(this.thrustRef, { fadeOutMs: 120 });
            this.thrustRef = null;
        }
    }

    shoot(volume = 1, pan = 0): void {
        BT.soundPlay(this.shootClip, { volume: 0.35 * volume, pan, pitch: 0.95 + Math.random() * 0.1 });
    }

    /** `speed` is how hard the ship hit (closing speed in px/s). */
    bounce(speed: number): void {
        const now = performance.now();

        if (speed < BOUNCE_MIN_SPEED || now - this.lastBounceMs < BOUNCE_COOLDOWN_MS) {
            return;
        }

        this.lastBounceMs = now;
        BT.soundPlay(this.bounceClip, {
            volume: Math.min(0.55, 0.15 + speed / 500),
            pitch: 0.9 + Math.random() * 0.2,
        });
    }

    explode(volume = 1, pan = 0): void {
        BT.soundPlay(this.explodeClip, { volume: 0.8 * volume, pan, priority: 10 });
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

function loadMuted(): boolean {
    try {
        return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
        return false;
    }
}
