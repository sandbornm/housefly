import { expect, test } from "@playwright/test";

for (const activity of ["piano", "flyout", "flypv"] as const) {
  test(`${activity} renders connected activity and preserves pause`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/simulations/${activity}/`);
    const brain = page.locator('.activity-connectome[data-ready="true"]');
    await expect(brain).toBeVisible({ timeout: 45_000 });
    await expect(brain).toHaveAttribute("data-nodes", "139662");
    await expect(brain).toHaveAttribute("data-edges", "60000");
    if (activity === "flyout") await page.locator("#autoplay").check();
    await expect.poll(async () => Number(await brain.getAttribute("data-active"))).toBeGreaterThan(10);
    const viewport = page.viewportSize()!;
    const box = (await brain.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

    const pixels = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#field, #scene")!;
      const gl = canvas.getContext("webgl2")!;
      const view = document.querySelector(".connectome-viewport")!.getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();
      const ratio = gl.drawingBufferWidth / rect.width;
      const width = Math.floor(view.width * ratio), height = Math.floor(view.height * ratio);
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(Math.round((view.left - rect.left) * ratio), Math.round((rect.bottom - view.bottom) * ratio), width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      let lit = 0;
      const colors = new Set<number>();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 120) lit++;
        colors.add((data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4));
      }
      return { lit, colors: colors.size, error: gl.getError() };
    });
    expect(pixels.error).toBe(0);
    expect(pixels.lit).toBeGreaterThan(100);
    expect(pixels.colors).toBeGreaterThan(20);
    await page.screenshot({ path: testInfo.outputPath(`${activity}.png`) });

    await page.locator(activity === "piano" ? "#play" : "#pause").click();
    await expect(brain).toHaveAttribute("data-paused", "true");
    const frozen = await brain.getAttribute("data-energy");
    await page.waitForTimeout(250);
    expect(await brain.getAttribute("data-energy")).toBe(frozen);
    expect(errors).toEqual([]);
  });
}
