// Mutopia-2015/08/18-931, first strain through the first ending, without its repeat.
// Public-domain edition: Breitkopf & Hartel (1888), typeset by Stelios Samelis.
// Each pair is [MIDI pitch (null = rest), duration in sixteenth notes].
export type WrittenEvent = readonly [number | null, number];
export interface WrittenMeasure { right: readonly WrittenEvent[]; left: readonly WrittenEvent[] }

export const EXCERPT: readonly WrittenMeasure[] = [
  { right: [[76, 1], [75, 1]], left: [[null, 2]] },
  { right: [[76, 1], [75, 1], [76, 1], [71, 1], [74, 1], [72, 1]], left: [[null, 6]] },
  { right: [[69, 2], [null, 1], [60, 1], [64, 1], [69, 1]], left: [[45, 1], [52, 1], [57, 1], [null, 3]] },
  { right: [[71, 2], [null, 1], [64, 1], [68, 1], [71, 1]], left: [[40, 1], [52, 1], [56, 1], [null, 3]] },
  { right: [[72, 2], [null, 1], [64, 1], [76, 1], [75, 1]], left: [[45, 1], [52, 1], [57, 1], [null, 3]] },
  { right: [[76, 1], [75, 1], [76, 1], [71, 1], [74, 1], [72, 1]], left: [[null, 6]] },
  { right: [[69, 2], [null, 1], [60, 1], [64, 1], [69, 1]], left: [[45, 1], [52, 1], [57, 1], [null, 3]] },
  { right: [[71, 2], [null, 1], [64, 1], [72, 1], [71, 1]], left: [[40, 1], [52, 1], [56, 1], [null, 3]] },
  { right: [[69, 4]], left: [[45, 1], [52, 1], [57, 1], [null, 1]] },
];
