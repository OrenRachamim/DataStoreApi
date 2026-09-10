/**
 * DL-03: open a signed share link to an HTML item in headless Chromium and
 * report what the sandboxed script could reach. Expected: cookie and
 * localStorage blocked with SecurityError, window.origin "null", script ran.
 *
 * Usage: LINK="https://share.../d/itm_...?exp=..&gen=..&sig=.." \
 *        CHROME=/path/to/chrome node scripts/browser-sandbox-check.mjs
 * Requires playwright-core (npx -p playwright-core node ...). The HTML item
 * should contain the probe from scripts/sandbox-probe.html.
 */
import { chromium } from "playwright-core";

const link = process.env.LINK;
if (!link) throw new Error("LINK is required");
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const page = await browser.newPage();
try {
  const res = await page.goto(link, { waitUntil: "commit", timeout: 15000 });
  console.log("status:", res?.status(), "csp:", res?.headers()["content-security-policy"]);
  await page.waitForFunction(() => document.getElementById("h")?.textContent !== "pending", null, { timeout: 10000 });
  console.log("probe:", await page.textContent("#h"));
} finally {
  await browser.close();
}
