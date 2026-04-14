// Capture the actual labeling UI with video player + timeline rendered
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const DEV_BASE = process.env.DEV_BASE || "http://34.158.214.84:45454";
const TARGET = process.argv[2] || "/projects/1/data?tab=1&task=1";
const WIDTH = Number(process.env.W || 1920);
const HEIGHT = Number(process.env.H || 1080);
const OUT = process.argv[3] || `labeling-${Date.now()}.png`;

await mkdir("screenshots", { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") console.error("[browser]", msg.text().slice(0, 200));
});

// Login
console.error("[auth] login");
await page.goto(new URL("/user/login/", DEV_BASE).toString(), { waitUntil: "domcontentloaded" });
await page.fill('input[name="email"]', process.env.LS_EMAIL);
await page.fill('input[name="password"]', process.env.LS_PASSWORD);
await Promise.all([
  page.waitForLoadState("networkidle").catch(() => {}),
  page.click('button[type="submit"]'),
]);

// Navigate to labeling
console.error("[nav]", TARGET);
await page.goto(new URL(TARGET, DEV_BASE).toString(), { waitUntil: "networkidle", timeout: 90000 });

// Wait for video element or timeline to render
const waits = [
  page.waitForSelector("video", { timeout: 30000 }).catch(() => null),
  page.waitForSelector("[class*='timeline']", { timeout: 30000 }).catch(() => null),
  page.waitForSelector("[class*='lsf-video']", { timeout: 30000 }).catch(() => null),
];
await Promise.any(waits).catch(() => {});
console.error("[render] initial ready");

// Let timeline + minimap populate, video metadata load
await page.waitForTimeout(6000);

// Dismiss any tooltips/popovers by clicking on a safe area
await page.mouse.click(5, 5).catch(() => {});

const outPath = path.join("screenshots", OUT);
await page.screenshot({ path: outPath, fullPage: false });
console.log(outPath);

await browser.close();
