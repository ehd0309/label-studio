import { chromium } from "@playwright/test";
import path from "node:path";

const DEV_BASE = process.env.DEV_BASE || "http://34.158.214.84:45454";
const TARGET = process.argv[2] || "/projects/1/data?tab=1&task=1";
const OUT = process.argv[3] || `minimap-${Date.now()}.png`;
const WIDTH = Number(process.env.W || 1920);
const HEIGHT = Number(process.env.H || 1080);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

await page.goto(new URL("/user/login/", DEV_BASE).toString(), { waitUntil: "domcontentloaded" });
await page.fill('input[name="email"]', process.env.LS_EMAIL);
await page.fill('input[name="password"]', process.env.LS_PASSWORD);
await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), page.click('button[type="submit"]')]);

await page.goto(new URL(TARGET, DEV_BASE).toString(), { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(5000);

// Try to locate the seeker (contains minimap) element
const seeker = page.locator("[class*='seeker']").first();
const outPath = path.join("screenshots", OUT);
try {
  await seeker.waitFor({ state: "visible", timeout: 8000 });
  await seeker.screenshot({ path: outPath });
  console.log("seeker captured:", outPath);
} catch {
  await page.screenshot({ path: outPath, fullPage: true });
  console.log("fallback full-page:", outPath);
}
await browser.close();
