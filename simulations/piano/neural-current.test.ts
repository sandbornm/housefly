import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { NeuralRuntime } from "../../src/neural/runtime.ts";
import { PianoNeuralSession } from "./neural-session.ts";
import { ASSOCIATED_PIANO_ENCODER } from "./sensory-associated.ts";
import { DEFAULT_BPM } from "./score.ts";

test("shipped v2b weights drive actual WASM contacts; silencing removes actions without changing weights", { timeout: 30000 }, async () => {
  const graph = await NeuralRuntime.load(new URL("../../public/", import.meta.url), { read: async url => {
    const bytes = await readFile(url);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } });
  const runtime = new NeuralRuntime(graph, 931), errors: Error[] = [];
  const session = new PianoNeuralSession(async () => ({
    graph,
    advance: async (rates, ms) => runtime.advance(rates, ms), snapshot: async () => runtime.snapshot(),
    reset: async () => runtime.reset(), silence: async enabled => runtime.silence(enabled), dispose: async () => runtime.dispose(),
  }), error => errors.push(error), { calibration: async () => JSON.parse(await readFile(new URL("./calibration-v2.json", import.meta.url), "utf8")) });
  let step = 0;
  async function advance(count: number) {
    const contacts = [];
    for (let i = 0; i < count; i++) {
      session.update(50, step++ * 0.05 * DEFAULT_BPM / 60, DEFAULT_BPM, true, false);
      await new Promise(resolve => setImmediate(resolve));
      contacts.push(...session.takeContacts());
    }
    return contacts;
  }
  try {
    await session.ready;
    const initial = session.snapshot();
    assert.equal(DEFAULT_BPM, 72); assert.equal(initial.encoder, ASSOCIATED_PIANO_ENCODER);
    assert.equal(initial.calibrating, false); assert.equal(initial.calibrationSource.kind, "offline-balanced");
    assert.equal(initial.calibrationSource.improved, false);
    assert.equal(initial.updates.length, 12); assert.ok(initial.updates.every(head => head.updates! > 0));
    const active = await advance(40);
    assert.ok(active.length > 0); assert.ok(session.neuralFrame!.totalSpikes > 0);
    for (const event of active) {
      assert.equal(event.source, "neural"); assert.ok(event.neuralTick! > 0);
      assert.equal(event.requestedNoteIndex, null);
    }
    await session.silence(true);
    const quiet = session.snapshot();
    assert.deepEqual(await advance(20), []);
    const silenced = session.snapshot();
    assert.equal(silenced.acceptedCommands, quiet.acceptedCommands);
    assert.equal(silenced.actuator.totalContacts, quiet.actuator.totalContacts);
    assert.equal(silenced.runtime!.totalSpikes, quiet.runtime!.totalSpikes);
    assert.ok(silenced.runtime!.poolRates.every(rate => rate === 0));
    assert.ok(silenced.actuator.legs.every(leg => !leg.contact));
    await session.silence(false);
    assert.ok((await advance(40)).length > 0);
    assert.deepEqual(session.snapshot().updates, initial.updates);
    assert.deepEqual(errors, []);
  } finally { session.dispose(); }
});
