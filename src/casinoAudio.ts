import type { Action } from "./activities/blackjack";

/** Original synthesized cues; no samples, voices, or network requests. */
export class CasinoAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = false;

  async toggle(): Promise<boolean> {
    try {
      this.context ??= new AudioContext();
      if (!this.master) {
        this.master = this.context.createGain();
        this.master.gain.value = 0;
        this.master.connect(this.context.destination);
      }
      await this.context.resume();
      this.enabled = !this.enabled;
      this.master.gain.setTargetAtTime(this.enabled ? 0.18 : 0, this.context.currentTime, 0.015);
      if (this.enabled) this.tone(300, 460, 0, 0.11, "triangle");
    } catch { this.enabled = false; }
    return this.enabled;
  }

  private tone(from: number, to: number, offset: number, duration: number, type: OscillatorType = "sine"): void {
    if (!this.enabled || !this.context || !this.master) return;
    const start = this.context.currentTime + offset;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(0.42, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.001, start + duration);
    oscillator.connect(envelope); envelope.connect(this.master);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    oscillator.start(start); oscillator.stop(start + duration + 0.02);
  }

  deal(): void { this.tone(1200, 240, 0, 0.05, "triangle"); }

  action(action: Action): void {
    if (action === "Hit" || action === "Double") {
      this.tone(180, 70, 0, 0.12, "triangle");
      this.tone(220, 350, 0.10, 0.10, "sawtooth");
      if (action === "Double") this.tone(180, 70, 0.24, 0.12, "triangle");
    } else if (action === "Stand") {
      this.tone(380, 200, 0, 0.17, "triangle");
      this.tone(220, 150, 0.19, 0.19, "triangle");
    } else {
      this.tone(260, 620, 0, 0.22, "triangle");
      this.tone(260, 120, 0.08, 0.22, "triangle");
    }
  }

  result(reward: number): void {
    if (reward > 0) {
      [523.25, 659.25, 783.99, 1046.5].forEach((note, i) => this.tone(note, note, i*0.12, 0.3, "triangle"));
    } else if (reward < 0) {
      this.tone(260, 180, 0, 0.22, "triangle");
      this.tone(180, 100, 0.22, 0.25, "triangle");
    } else this.tone(340, 340, 0, 0.15, "sine");
  }
}
