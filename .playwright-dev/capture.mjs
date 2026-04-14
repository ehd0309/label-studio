// Usage:
//   node capture.mjs <path_or_url> [--full] [--width 1920] [--height 1080] [--out name.png]
// Examples:
//   node capture.mjs /projects                      # login page screenshot to default name
//   node capture.mjs /projects/5/data --full        # full-page screenshot
//   node capture.mjs https://...other.site
//
// Requires env LS_EMAIL / LS_PASSWORD to pre-authenticate against DEV_BASE.
//   DEV_BASE defaults to http://34.158.214.84:45454

import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const DEV_BASE = process.env.DEV_BASE || "http://34.158.214.84:45454";
const args = process.argv.slice(2);
let target = args[0] || "/";
let full = false;
let width = 1440;
let height = 900;
let outName = null;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--full") full = true;
  else if (a === "--width") width = Number(args[++i]);
  else if (a === "--height") height = Number(args[++i]);
  else if (a === "--out") outName = args[++i];
}

const url = target.startsWith("http") ? target : new URL(target, DEV_BASE).toString();
const screenshotDir = path.resolve(".", "screenshots");
await mkdir(screenshotDir, { recursive: true });

const fileName =
  outName ||
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${target.replace(/[\/?&=]/g, "_")}.png`;
const outPath = path.join(screenshotDir, fileName);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

// Pre-auth if creds provided
if (process.env.LS_EMAIL && process.env.LS_PASSWORD) {
  console.error("[auth] logging in as", process.env.LS_EMAIL);
  await page.goto(new URL("/user/login/", DEV_BASE).toString(), { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', process.env.LS_EMAIL);
  await page.fill('input[name="password"]', process.env.LS_PASSWORD);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
}

await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(1500); // allow late async render

await page.screenshot({ path: outPath, fullPage: full });
console.log(outPath);

await browser.close();
