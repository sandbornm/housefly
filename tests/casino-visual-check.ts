import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Run against the existing local server: node tests/casino-visual-check.ts
const output = "test-results/casino-evolved";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report: object[] = [];

async function pixels(page: Page, selector: string) {
  return page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl2")!;
    const data = new Uint8Array(canvas.width*canvas.height*4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    let bright=0, green=0, red=0, hash=0, flyHash=0;
    let minX=canvas.width, maxX=0, minY=canvas.height, maxY=0;
    for (let i=0;i<data.length;i+=4) {
      const x=(i/4)%canvas.width, y=Math.floor(i/4/canvas.width);
      if (data[i]>45 && data[i+1]>45 && data[i+2]>45) {
        bright++; minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      }
      if (data[i+1]>data[i]*1.3 && data[i+1]>45) green++;
      // Compound eyes must be present above the chip rack.
      if (x>canvas.width*.60 && y>canvas.height*.36 && y<canvas.height*.68 && data[i]>data[i+1]*1.4 && data[i]>50) red++;
      if (i%64===0) {
        hash=(Math.imul(hash,31)+data[i]+data[i+1]+data[i+2])>>>0;
        if (x>canvas.width*.6) flyHash=(Math.imul(flyHash,31)+data[i]+data[i+1])>>>0;
      }
    }
    return {bright,green,red,hash,flyHash,minX,maxX,minY,maxY,width:canvas.width,height:canvas.height};
  });
}

async function load(page: Page, seed=5) {
  await page.goto(`http://127.0.0.1:5173/?autoplay=0&seed=${seed}`);
  await expect(page.locator("#brainCanvas")).toHaveAttribute("data-ready","true",{timeout:20_000});
  await page.locator("#dealButton").click();
  await expect(page.locator("#standButton")).toBeEnabled({timeout:20_000});
  await page.waitForTimeout(550);
}

try {
  for (const viewport of [{width:1440,height:1120},{width:1920,height:1080},{width:390,height:844}]) {
    const name=`${viewport.width}x${viewport.height}`;
    const page=await browser.newPage({viewport,deviceScaleFactor:viewport.width===390?2:1,isMobile:viewport.width===390});
    const errors: string[]=[];
    page.on("pageerror",error=>errors.push(error.message));
    await load(page);
    const table=await pixels(page,"#scene");
    assert(table.green>1500 && table.bright>1000,"Table and cards render");
    assert(table.red>25,"Fly compound eyes render");
    const brain=await pixels(page,"#brainCanvas");
    assert(brain.bright>1000,"Anatomy renders");
    assert(brain.minX>3 && brain.maxX<brain.width-3 && brain.minY>3 && brain.maxY<brain.height-3,"Anatomy stays framed");
    await page.screenshot({path:`${output}/${name}-table.png`,fullPage:true});
    await page.locator("#standButton").click();
    await expect(page.locator("#scene")).toHaveAttribute("data-gesture","Stand");
    await page.waitForTimeout(100);
    const gesture1=await pixels(page,"#scene");
    await page.waitForTimeout(180);
    const gesture2=await pixels(page,"#scene");
    assert.notEqual(gesture1.flyHash,gesture2.flyHash,"Stand moves the fly");
    await expect(page.locator("#roundResult")).toHaveAttribute("data-outcome","win");
    await expect(page.locator("#scene")).toHaveAttribute("data-celebrating","true");
    await expect(page.locator("#scene")).toHaveAttribute("data-returned","2");
    const win1=await pixels(page,"#scene");
    await page.waitForTimeout(200);
    const win2=await pixels(page,"#scene");
    assert.notEqual(win1.flyHash,win2.flyHash,"Win celebration moves");
    await page.screenshot({path:`${output}/${name}-win.png`,fullPage:true});
    const activity=await page.locator("#activeNeurons").textContent();
    assert(Number(activity?.replaceAll(",",""))>0,"Action drives neural activity");
    assert.notEqual(brain.hash,(await pixels(page,"#brainCanvas")).hash,"Anatomy animates");
    await expect(page.locator("#scene")).toHaveAttribute("data-chip-motion","idle");
    await expect(page.locator("#scene")).toHaveAttribute("data-celebrating","false");
    const drawCalls=Number(await page.locator("#scene").getAttribute("data-draw-calls"));
    assert(drawCalls<230,"Draw calls stay bounded");
    const layout=await page.evaluate(()=>{
      const overlaps: string[]=[];
      for (const selector of [".topbar",".button-row",".settings-row",".brain-toolbar"]) {
        const children=[...document.querySelector(selector)!.children].filter(el=>getComputedStyle(el).display!=="none");
        children.forEach((a,i)=>children.slice(i+1).forEach(b=>{
          const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();
          if (Math.min(x.right,y.right)-Math.max(x.left,y.left)>1 && Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1) overlaps.push(selector);
        }));
      }
      return {overflow:document.documentElement.scrollWidth>innerWidth,overlaps};
    });
    assert.deepEqual(layout,{overflow:false,overlaps:[]});
    await page.locator("#brainMode").selectOption("classes");
    await page.locator("#showEdges").check();
    await page.locator("#resetBrain").click();
    const classPixels=await pixels(page,"#brainCanvas");
    assert(classPixels.bright>1000,"Class and connection view renders");
    assert.deepEqual(errors,[]);
    report.push({viewport,table,brain,activity,drawCalls,layout,errors});
    console.log(`${name}: table, fly, cards, anatomy, Stand, payout, win motion, activity and layout PASS`);
    await page.close();
  }
  const page=await browser.newPage({viewport:{width:1440,height:1120}});
  await load(page);
  await page.locator("#hitButton").click();
  await expect(page.locator("#scene")).toHaveAttribute("data-gesture","Hit");
  const hit1=await pixels(page,"#scene");
  await page.waitForTimeout(180);
  assert.notEqual(hit1.flyHash,(await pixels(page,"#scene")).flyHash,"Hit taps the table");
  await page.screenshot({path:`${output}/hit.png`,fullPage:true});
  await expect(page.locator("#roundResult")).toHaveAttribute("data-outcome","loss");
  await expect(page.locator("#scene")).toHaveAttribute("data-celebrating","false");
  await expect(page.locator("#scene")).toHaveAttribute("data-returned","0");
  await load(page);
  await page.locator("#splitButton").click();
  await expect(page.locator("#handsReadout .hand-summary")).toHaveCount(2);
  await expect(page.locator("#scene")).toHaveAttribute("data-stake","2");
  await expect(page.locator("#doubleButton")).toBeEnabled();
  await page.locator("#doubleButton").click();
  await expect(page.locator("#scene")).toHaveAttribute("data-gesture","Double");
  await expect(page.locator("#scene")).toHaveAttribute("data-stake","3");
  await expect(page.locator("#replayButton")).toBeEnabled();
  if (await page.locator("#standButton").isEnabled()) {
    await page.locator("#standButton").click();
    await expect(page.locator("#dealButton")).toBeEnabled();
  }
  await page.screenshot({path:`${output}/split-double.png`,fullPage:true});
  report.push({actions:"Hit/loss, Split, Double passed without changing game state or forcing outcomes"});
  await writeFile(`${output}/verification.json`,JSON.stringify(report,null,2));
  console.log("Hit/loss, Split, Double: PASS");
} finally { await browser.close(); }
