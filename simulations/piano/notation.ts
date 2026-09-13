import { Accidental, Barline, Beam, Dot, Formatter, Fraction, Renderer, Stave, StaveConnector, StaveNote, StaveTie, Voice } from "vexflow/bravura";
import { MEASURES, SCORE, TOTAL_BEATS, activeNotes, measureAt } from "./score";
import { engravingKey, interpolatePlayhead, notationEvents } from "./notation-model";
import type { NotationEvent } from "./notation-model";
import type { PianoAssessment } from "./assessment";

interface DrawnNote { note: StaveNote; event: NotationEvent; element?: SVGElement }

export class PianoNotation {
  readonly ready: Promise<void>;
  private strip = document.createElement("div");
  private cursor = document.createElement("div");
  private highlight = document.createElement("div");
  private anchors: { beat: number; x: number }[] = [];
  private measures: { x: number; width: number }[] = [];
  private notes: DrawnNote[] = [];
  private beat = 0;
  private currentMeasure = -1;
  private previousActive = "";
  private previousBeat = -1;
  private disposed = false;
  private loaded = false;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private events = new AbortController();
  private pointerStart = 0;
  private browsing = false;
  private outcomes: ReturnType<PianoAssessment["snapshot"]> | null = null;

  constructor(private mount: HTMLElement, private seek: (beat: number) => void) {
    this.strip.className = "notation-strip";
    this.cursor.className = "notation-cursor";
    this.highlight.className = "notation-measure";
    this.cursor.setAttribute("aria-hidden", "true"); this.highlight.setAttribute("aria-hidden", "true");
    mount.append(this.strip);
    mount.addEventListener("pointerdown", event => { this.pointerStart = event.clientX; }, { signal: this.events.signal });
    mount.addEventListener("pointerup", this.pointerUp, { signal: this.events.signal });
    mount.addEventListener("wheel", () => { this.browsing = true; }, { signal: this.events.signal, passive: true });
    mount.addEventListener("keydown", event => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const index = measureAt(this.beat).index;
        this.seek(event.key === "Home" ? 0 : event.key === "End" ? TOTAL_BEATS : MEASURES[Math.max(0, Math.min(MEASURES.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)))].beat);
      }
    }, { signal: this.events.signal });
    // The Bravura entry embeds its fonts; no runtime CDN or font request is needed.
    this.ready = document.fonts.ready.then(() => {
      if (this.disposed) return;
      this.draw(); this.loaded = true; mount.dataset.ready = "true"; this.update(this.beat, false, 0);
    }).catch(error => {
      mount.dataset.error = "true"; mount.textContent = "Sheet music unavailable";
      console.warn("Piano notation could not load", error);
    });
  }

  private draw(): void {
    const width = MEASURES.reduce((total, measure, index) => total + (measure.pickup ? 160 : 252) + (index === 0 ? 80 : 0), 40);
    this.strip.style.width = `${width}px`;
    const renderer = new Renderer(this.strip, Renderer.Backends.SVG); renderer.resize(width, 160);
    const context = renderer.getContext(); context.setFillStyle("#273934").setStrokeStyle("#273934");
    let x = 24;
    const previous = new Map<string, StaveNote>();
    for (const measure of MEASURES) {
      const first = measure.index === 0;
      const measureWidth = (measure.pickup ? 160 : 252) + (first ? 80 : 0);
      this.measures.push({ x, width: measureWidth });
      const treble = new Stave(x, -4, measureWidth, { spacingBetweenLinesPx: 8 });
      const bass = new Stave(x, 62, measureWidth, { spacingBetweenLinesPx: 8 });
      if (first) {
        treble.addClef("treble").addTimeSignature("3/8"); bass.addClef("bass").addTimeSignature("3/8");
      }
      if (measure.index === MEASURES.length - 1) {
        treble.setEndBarType(Barline.type.END); bass.setEndBarType(Barline.type.END);
      }
      const start = Math.max(treble.getNoteStartX(), bass.getNoteStartX());
      treble.setNoteStartX(start); bass.setNoteStartX(start);
      treble.setContext(context).draw(); bass.setContext(context).draw();
      new StaveConnector(treble, bass).setType(first ? StaveConnector.type.BRACE : StaveConnector.type.SINGLE_LEFT).setContext(context).draw();
      context.setFont("Arial", 10).fillText(measure.pickup ? "Pickup" : String(measure.number), x + (first ? 8 : 5), 12);
      const voices: Voice[] = [], beams: Beam[] = [], measureNotes: DrawnNote[] = [];
      for (const hand of ["right", "left"] as const) {
        const stave = hand === "right" ? treble : bass;
        const accidentals = new Map<string, string>();
        const events = notationEvents(SCORE, measure, hand);
        const notes = events.map(event => {
          const keys = event.midis.map(engravingKey);
          const note = new StaveNote({ clef: hand === "right" ? "treble" : "bass", keys: keys.length ? keys.map(key => key.key) : [hand === "right" ? "b/4" : "d/3"], duration: event.value + (keys.length ? "" : "r"), dots: event.dotted ? 1 : 0, autoStem: true });
          note.setStave(stave);
          if (event.dotted) Dot.buildAndAttach([note]);
          keys.forEach((key, index) => {
            const pitch = key.key.replace("#", "");
            const accidental = key.accidental ?? "n";
            if ((accidentals.get(pitch) ?? "n") !== accidental && !event.tied.includes(event.midis[index])) note.addModifier(new Accidental(accidental), index);
            accidentals.set(pitch, accidental);
          });
          const drawn = { note, event }; measureNotes.push(drawn); return note;
        });
        beams.push(...Beam.generateBeams(notes, { groups: [new Fraction(3, 8)], beamRests: false }));
        const voice = new Voice({ numBeats: measure.duration * 4, beatValue: 16 }).addTickables(notes).setStave(stave);
        voices.push(voice);
      }
      new Formatter().joinVoices([voices[0]]).joinVoices([voices[1]]).formatToStave(voices, treble);
      voices.forEach(voice => voice.draw(context));
      beams.forEach(beam => beam.setContext(context).draw());
      for (const drawn of measureNotes) {
        const { note, event } = drawn;
        drawn.element = note.getSVGElement();
        drawn.element?.classList.add("notation-note");
        drawn.element?.setAttribute("data-beat", String(event.beat));
        this.anchors.push({ beat: event.beat, x: note.getAbsoluteX() });
        event.midis.forEach((midi, index) => {
          const key = `${note.getStave()?.getClef()}-${midi}`;
          const prior = previous.get(key);
          if (event.tied.includes(midi) && prior) new StaveTie({ firstNote: prior, lastNote: note, firstIndexes: [prior.getKeys().indexOf(engravingKey(midi).key)], lastIndexes: [index] }).setContext(context).draw();
          previous.set(key, note);
        });
      }
      this.notes.push(...measureNotes);
      x += measureWidth;
    }
    this.anchors.sort((a, b) => a.beat - b.beat);
    this.anchors = this.anchors.filter((anchor, index, all) => index === 0 || anchor.beat !== all[index - 1].beat);
    this.anchors.push({ beat: TOTAL_BEATS, x: width - 22 });
    this.strip.append(this.highlight, this.cursor);
    this.strip.querySelector("svg")?.setAttribute("aria-hidden", "true");
  }

  update(beat: number, playing: boolean, seconds: number): void {
    this.beat = beat;
    if (!this.loaded || this.disposed) return;
    const measure = measureAt(beat);
    const jumped = this.previousBeat < 0 || Math.abs(beat - this.previousBeat) > 0.4 || beat < this.previousBeat;
    if (jumped || playing) this.browsing = false;
    if (this.currentMeasure !== measure.index) {
      this.currentMeasure = measure.index;
      const box = this.measures[measure.index];
      this.highlight.style.left = `${box.x}px`; this.highlight.style.width = `${box.width}px`;
      this.mount.setAttribute("aria-label", `Requested Fur Elise score, ${measure.pickup ? "pickup" : `measure ${measure.number}`} of the opening excerpt, treble and bass staves`);
    }
    const x = interpolatePlayhead(beat, this.anchors);
    this.cursor.style.transform = `translateX(${x}px)`;
    const target = Math.max(0, Math.min(this.strip.offsetWidth - this.mount.clientWidth, x - this.mount.clientWidth * 0.34));
    if (!this.browsing && (playing || jumped)) {
      this.mount.scrollLeft = jumped || this.reducedMotion ? target : this.mount.scrollLeft + (target - this.mount.scrollLeft) * (1 - Math.exp(-seconds * 12));
    }
    const active = activeNotes(beat);
    const signature = active.map(note => `${note.beat}:${note.midi}`).join(",");
    if (signature !== this.previousActive) {
      this.previousActive = signature;
      this.notes.forEach(({ element, event }) => element?.classList.toggle("is-active", beat >= event.beat && beat < event.beat + event.duration && active.some(note => event.midis.includes(note.midi))));
    }
    this.previousBeat = beat;
    this.mount.dataset.beat = beat.toFixed(4); this.mount.dataset.measure = String(measure.index);
  }

  showPerformance(assessment: ReturnType<PianoAssessment["snapshot"]>): void {
    this.outcomes = assessment;
    for (const { element, event } of this.notes) {
      if (!element || !event.midis.length) continue;
      const indices = SCORE.map((note, index) => ({ note, index })).filter(({ note }) => note.beat === event.beat && event.midis.includes(note.midi));
      const outcomes = indices.map(({ index }) => assessment.outcomes[index]);
      element.classList.toggle("is-performed", outcomes.includes("on-time"));
      element.classList.toggle("is-late", outcomes.includes("late") || outcomes.includes("early"));
      element.classList.toggle("is-missed", outcomes.includes("missed"));
    }
  }

  private pointerUp = (event: PointerEvent): void => {
    if (Math.abs(event.clientX - this.pointerStart) > 6) { this.browsing = true; return; }
    const x = event.clientX - this.mount.getBoundingClientRect().left + this.mount.scrollLeft;
    const closest = this.anchors.reduce((a, b) => Math.abs(a.x - x) < Math.abs(b.x - x) ? a : b);
    this.seek(closest.beat);
  };

  snapshot() { return { ready: this.loaded, beat: this.beat, measure: this.currentMeasure, scroll: this.mount.scrollLeft, notes: this.notes.length, anchors: this.anchors, scoreRole: "requested", performed: this.outcomes }; }
  dispose(): void { this.disposed = true; this.events.abort(); this.mount.replaceChildren(); }
}
