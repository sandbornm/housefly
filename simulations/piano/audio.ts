import { TOTAL_BEATS, noteName } from "./score";
import type { PerformedNote } from "./actuator";
import type * as ToneTypes from "tone";
import * as Tone from "tone";

export class PianoAudio {
  private tone: typeof ToneTypes | null = null;
  private body?: ToneTypes.PolySynth;
  private hammer?: ToneTypes.PolySynth;
  private reverb?: ToneTypes.Reverb;
  private filter?: ToneTypes.Filter;
  private compressor?: ToneTypes.Compressor;
  private limiter?: ToneTypes.Limiter;
  private volume?: ToneTypes.Volume;
  private meter?: ToneTypes.Meter;
  private performed: { eventId: number; midi: number; time: number }[] = [];
  private loading?: Promise<void>;
  private disposed = false;
  ready = false;
  muted = false;
  level = 0.65;

  enable(): Promise<void> {
    if (this.ready && this.tone) return this.tone.start();
    if (this.loading) return this.loading;
    this.loading = this.initialize().catch(error => {
      this.releaseNodes(); this.tone = null; this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  private async initialize(): Promise<void> {
    if (this.disposed) return;
    await Tone.start();
    if (this.disposed) return;
    this.tone = Tone;
    this.volume = new Tone.Volume(-12).toDestination();
    this.meter = new Tone.Meter({ normalRange: true, smoothing: 0 }); this.volume.connect(this.meter);
    this.limiter = new Tone.Limiter(-1).connect(this.volume);
    this.compressor = new Tone.Compressor({ threshold: -20, ratio: 2.5, attack: 0.006, release: 0.3 }).connect(this.limiter);
    this.reverb = new Tone.Reverb({ decay: 2.7, preDelay: 0.016, wet: 0.23 }).connect(this.compressor);
    this.filter = new Tone.Filter({ frequency: 4200, type: "lowpass", rolloff: -12, Q: 0.4 }).connect(this.reverb);
    // Original additive voices: a decaying string body and a short hammer layer.
    // No sampled recordings, external sample requests, or artist imitation.
    this.body = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "custom", partials: [1, 0.36, 0.19, 0.1, 0.045, 0.024, 0.01] },
      envelope: { attack: 0.003, decay: 2.5, sustain: 0.018, release: 1.5, attackCurve: "linear", decayCurve: "exponential" },
      volume: -8,
    }).connect(this.filter);
    // Six limbs can restrike while prior 1.5-second release tails still sound.
    // Bound the pool above that overlap instead of silently dropping note bodies.
    this.body.maxPolyphony = 128;
    this.hammer = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.001, decay: 0.075, sustain: 0, release: 0.045 },
      volume: -24,
    }).connect(this.filter);
    await this.reverb.ready;
    if (this.disposed) { this.releaseNodes(); return; }
    const transport = Tone.getTransport();
    transport.loopStart = 0; transport.loopEnd = `${TOTAL_BEATS * transport.PPQ}i`;
    this.ready = true; this.setVolume(this.level); this.setMuted(this.muted);
  }

  sync(beat: number, bpm: number, playing: boolean, loop: boolean): void {
    if (!this.ready || !this.tone) return;
    const transport = this.tone.getTransport();
    transport.pause(); this.releaseVoices();
    transport.bpm.value = bpm; transport.loop = loop;
    transport.ticks = beat * transport.PPQ;
    if (playing) transport.start("+0.04", `${beat * transport.PPQ}i`);
  }

  getBeat(): number | null {
    if (!this.ready || !this.tone) return null;
    return this.tone.getTransport().getTicksAtTime(this.tone.immediate()) / this.tone.getTransport().PPQ;
  }

  setTempo(bpm: number): void { if (this.tone && this.ready) this.tone.getTransport().bpm.value = bpm; }
  setLoop(loop: boolean): void { if (this.tone && this.ready) this.tone.getTransport().loop = loop; }
  setMuted(muted: boolean): void { this.muted = muted; if (this.volume) this.volume.mute = muted; }
  setVolume(level: number): void {
    this.level = Math.max(0, Math.min(1, level));
    if (this.volume && this.tone) this.volume.volume.rampTo(this.tone.gainToDb(Math.max(0.00001, this.level) * 0.8), 0.05);
  }

  audition(midi: number): void {
    if (!this.ready || !this.tone) return;
    const now = this.tone.now();
    this.body?.triggerAttackRelease(noteName(midi), 0.72, now, 0.65);
    this.hammer?.triggerAttackRelease(this.tone.Frequency(noteName(midi)).toFrequency() * 2, 0.06, now, 0.4);
  }

  perform(events: readonly PerformedNote[]): void {
    if (!this.ready || !this.tone) return;
    const time = this.tone.immediate();
    for (const event of events) {
      this.body?.triggerAttackRelease(noteName(event.midi), event.holdMs / 1000, time, event.velocity);
      this.hammer?.triggerAttackRelease(this.tone.Frequency(noteName(event.midi)).toFrequency() * 2, 0.06, time, event.velocity * 0.6);
      this.performed.push({ eventId: event.eventId, midi: event.midi, time });
    }
    if (this.performed.length > 256) this.performed.splice(0, this.performed.length - 256);
  }

  private releaseVoices(): void { this.body?.releaseAll(); this.hammer?.releaseAll(); }

  getDebugState(): object {
    return { ready: this.ready, muted: this.muted, level: this.level, beat: this.getBeat(), state: this.tone?.getContext().state ?? "uninitialized", rms: this.meter?.getValue() ?? 0,
      voices: { body: this.body?.activeVoices ?? 0, capacity: this.body?.maxPolyphony ?? 0 }, performed: [...this.performed] };
  }

  private releaseNodes(): void {
    this.body?.dispose(); this.hammer?.dispose(); this.filter?.dispose();
    this.reverb?.dispose(); this.compressor?.dispose(); this.limiter?.dispose(); this.volume?.dispose(); this.meter?.dispose();
    this.body = undefined; this.hammer = undefined; this.filter = undefined;
    this.reverb = undefined; this.compressor = undefined; this.limiter = undefined; this.volume = undefined; this.meter = undefined;
    this.ready = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.tone) this.tone.getTransport().stop();
    this.releaseNodes();
  }
}
