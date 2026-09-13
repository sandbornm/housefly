import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const baseURL=process.env.DEMO_URL??"http://127.0.0.1:5173";
const output=resolve("docs/media"),raw=resolve("test-results/recording");
function ffmpeg(args) {
  const result=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-y",...args],{stdio:"inherit"});
  if(result.error||result.status!==0)throw result.error??new Error(`ffmpeg exited ${result.status}`);
}
if(spawnSync("ffmpeg",["-version"]).status!==0)throw new Error("Install ffmpeg before recording.");
await mkdir(output,{recursive:true});await mkdir(raw,{recursive:true});
const browser=await chromium.launch();
try {
  const context=await browser.newContext({viewport:{width:1440,height:1120},deviceScaleFactor:1,recordVideo:{dir:raw,size:{width:1440,height:1120}}});
  const page=await context.newPage();const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  const started=Date.now();
  await page.goto(`${baseURL}/?autoplay=0&seed=5`);
  await page.locator('#brainCanvas[data-ready="true"]').waitFor({timeout:30000});
  await page.waitForTimeout(500);
  const trimStart=(Date.now()-started)/1000;
  await page.locator("#autoplayButton").click();
  await page.locator('#roundResult[data-outcome="win"]').waitFor({timeout:30000});
  await page.waitForTimeout(1600);
  await page.screenshot({path:resolve(output,"housefly-blackjack.png")});
  await page.waitForTimeout(6000);
  const duration=(Date.now()-started)/1000-trimStart;
  const video=page.video();await context.close();
  if(errors.length)throw new Error(errors.join("\n"));
  const source=await video.path(),mp4=resolve(output,"housefly-blackjack.mp4");
  ffmpeg(["-ss",trimStart.toFixed(3),"-i",source,"-t",duration.toFixed(3),"-an","-vf","fps=30","-c:v","libx264","-preset","slow","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",mp4]);
  ffmpeg(["-i",mp4,"-filter_complex","fps=12,scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a","-loop","0",resolve(output,"housefly-blackjack.gif")]);
  console.log(`Recorded ${duration.toFixed(1)}s of actual autoplay to docs/media/`);
} finally {await browser.close();}
