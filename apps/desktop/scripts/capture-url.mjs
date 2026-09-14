import { chromium } from "@playwright/test";

const [url, output] = process.argv.slice(2);
if (!url || !output) throw new Error("usage: node capture-url.mjs <url> <output.png>");
const browser = await chromium.launch({ executablePath: process.env.PI_CAD_CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on("console", (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => console.error(`[browser:error] ${error.message}`));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8_000);
await page.screenshot({ path: output });
await browser.close();
