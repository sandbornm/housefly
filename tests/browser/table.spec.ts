import { test, expect } from "@playwright/test";
import type { Locator } from "@playwright/test";

async function pixels(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const gl = element.getContext("webgl2") ?? element.getContext("webgl");
    if (!gl) throw new Error("WebGL unavailable");
    const data = new Uint8Array(element.width*element.height*4);
    gl.readPixels(0,0,element.width,element.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    let bright=0,green=0,hash=0;
    let minX=element.width,maxX=0,minY=element.height,maxY=0;
    for(let i=0;i<data.length;i+=4){
      if(data[i]>45&&data[i+1]>45&&data[i+2]>45){
        bright++;const x=(i/4)%element.width,y=Math.floor(i/4/element.width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      }
      if(data[i+1]>data[i]*1.3&&data[i+1]>45)green++;
      if(i%128===0)hash=(Math.imul(hash,31)+data[i]+data[i+1])>>>0;
    }
    return{bright,green,hash,minX,maxX,minY,maxY,width:element.width,height:element.height};
  });
}

test("autoplay runs unattended, pauses cleanly, and real anatomy is framed",async({page},testInfo)=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/?seed=5");
  await expect(page.locator("#brainCanvas")).toHaveAttribute("data-ready","true",{timeout:20000});
  await expect(page.locator("#brainCanvas")).toHaveAttribute("data-nodes","139662");
  await expect(page.locator("#roundResult")).toHaveAttribute("data-outcome", /win|loss|push/, { timeout: 20000 });
  const outcome = await page.locator("#roundResult").getAttribute("data-outcome");
  if (outcome === "win") {
    await expect(page.locator("#resultTitle")).toHaveText("Fly wins!");
    await expect(page.locator("#scene")).toHaveAttribute("data-celebrating","true");
    await expect(page.locator("#scene")).toHaveAttribute("data-chips","collecting");
  }
  await page.screenshot({path:testInfo.outputPath("resolved.png"),fullPage:true});
  await page.locator("#playSpeed").selectOption("4");
  await expect(page.locator("#sessionScore")).toContainText("Hand 2",{timeout:30000});
  await expect(page.locator("#hitButton")).toBeDisabled();
  const tablePixels=await pixels(page.locator("#scene"));
  expect(tablePixels.green).toBeGreaterThan(1500);
  const before=await pixels(page.locator("#brainCanvas"));
  await page.waitForTimeout(400);
  const after=await pixels(page.locator("#brainCanvas"));
  expect(after.bright).toBeGreaterThan(1000);
  expect(after.hash).not.toBe(before.hash);
  expect(after.minX).toBeGreaterThan(3);expect(after.maxX).toBeLessThan(after.width-3);
  expect(after.minY).toBeGreaterThan(3);expect(after.maxY).toBeLessThan(after.height-3);
  await page.locator("#autoplayButton").click();
  await expect(page.locator("#autoplayStatus")).toHaveText("Paused");
  const shoe=await page.locator("#shoeDepth").textContent();
  await page.waitForTimeout(1000);
  expect(await page.locator("#shoeDepth").textContent()).toBe(shoe);
  await page.locator("#brainMode").selectOption("classes");
  await expect(page.locator("#brainLegend")).toBeHidden();
  await page.locator("#showEdges").check();
  await page.locator("#resetBrain").click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("table.png"),fullPage:true});
  expect(errors).toEqual([]);
});

test("sound effects require opt-in and can be muted",async({page})=>{
  await page.goto("/?autoplay=0&seed=5");
  const sound=page.locator("#soundButton");
  await expect(sound).toHaveAttribute("aria-pressed","false");
  await sound.click();
  await expect(sound).toHaveAttribute("aria-pressed","true");
  await expect(sound).toHaveAccessibleName("Mute sound effects");
  await sound.click();
  await expect(sound).toHaveAttribute("aria-pressed","false");
});

test("manual split, double, replay and deferred shoe configuration",async({page},testInfo)=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/?autoplay=0&seed=5");
  await expect(page.locator("#brainCanvas")).toHaveAttribute("data-ready","true",{timeout:20000});
  await expect(page.locator("#shoeDepth")).toHaveText("52 / 52");
  await page.locator("#dealButton").click();
  await expect(page.locator("#splitButton")).toBeEnabled({timeout:15000});
  await page.locator("#deckCount").selectOption("8");
  await expect(page.locator("#settingsStatus")).toContainText("queued");
  await page.locator("#splitButton").click();
  await expect(page.locator("#scene")).toHaveAttribute("data-gesture","Split");
  await expect(page.locator("#handsReadout .hand-summary")).toHaveCount(2);
  await expect(page.locator("#doubleButton")).toBeEnabled();
  await page.locator("#doubleButton").click();
  await expect(page.locator("#scene")).toHaveAttribute("data-gesture","Double");
  await expect(page.locator("#replayButton")).toBeEnabled();
  await expect(page.locator("#handsReadout")).toContainText("2 units");
  const shoe=await page.locator("#shoeDepth").textContent();
  await page.locator("#replayButton").click();
  await expect(page.locator("#replayButton")).toBeEnabled();
  expect(await page.locator("#shoeDepth").textContent()).toBe(shoe);
  await expect(page.locator("#brainTrace")).toContainText("manual Double");
  if(await page.locator("#standButton").isEnabled()){
    await page.locator("#standButton").click();
    await expect(page.locator("#dealButton")).toBeEnabled();
  }
  await page.locator("#dealButton").click();
  await expect(page.locator("#shoeDepth")).toHaveText("413 / 416");
  await page.screenshot({path:testInfo.outputPath("split.png"),fullPage:true});
  expect(errors).toEqual([]);
});
