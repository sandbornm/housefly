import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { pianoControllerOptions } from "./controller-options.ts";

test("the current route defaults to frozen, offline-trained v2 at the original 72 BPM", async () => {
  assert.deepEqual(pianoControllerOptions(""), { version: "v2", cold: false, calibrating: false });
  const main = await readFile(new URL("./main.ts", import.meta.url), "utf8");
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  assert.match(main, /pianoControllerOptions\(location.search\)/);
  assert.doesNotMatch(html, /id="calibrate"[^>]*\bchecked\b/);
  assert.match(html, /id="tempo"[^>]*value="72"/);
});

test("historical v1 and cold weights require explicit selection; neither turns on teaching", () => {
  assert.deepEqual(pianoControllerOptions("?encoder=v1"), { version: "v1", cold: false, calibrating: false });
  assert.deepEqual(pianoControllerOptions("?encoder=v2&weights=cold"), { version: "v2", cold: true, calibrating: false });
  assert.deepEqual(pianoControllerOptions("?encoder=v2&calibrate=1"), { version: "v2", cold: false, calibrating: false });
});
