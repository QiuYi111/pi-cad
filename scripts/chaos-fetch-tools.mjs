#!/usr/bin/env node
// Cache the real Toxiproxy server binary so external-dependency faults run
// against the genuine tool instead of a bespoke re-implementation.
import { createWriteStream, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { get } from "node:https";
import { fileURLToPath } from "node:url";
import path from "node:path";

const VERSION = process.env.CHAOS_TOXIPROXY_VERSION ?? "2.12.0";
const PLATFORM = process.platform;
const ARCH = process.arch === "arm64" ? "arm64" : "amd64";
const assets = {
  linux: `toxiproxy-server-linux-${ARCH}`,
  darwin: `toxiproxy-server-darwin-${ARCH}`,
};
const asset = assets[PLATFORM];
const root = fileURLToPath(new URL("..", import.meta.url));
const target = path.join(root, ".chaos-cache", "bin", "toxiproxy-server");

if (!asset) {
  console.error(`toxiproxy prebuilt binary is not published for ${PLATFORM}/${ARCH}`);
  process.exit(1);
}
if (existsSync(target) && !process.argv.includes("--force")) {
  console.log(`toxiproxy-server already cached at ${target}`);
  process.exit(0);
}

const url = `https://github.com/Shopify/toxiproxy/releases/download/v${VERSION}/${asset}`;
mkdirSync(path.dirname(target), { recursive: true });
rmSync(target, { force: true });

const download = (currentUrl, redirects = 0) =>
  new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    get(currentUrl, { headers: { "user-agent": "reify-chaos-fetch" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(download(new URL(response.headers.location, currentUrl).toString(), redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed: ${response.statusCode} ${currentUrl}`));
        return;
      }
      const file = createWriteStream(target);
      response.pipe(file);
      file.on("finish", () => file.close(() => resolve(undefined)));
      file.on("error", reject);
    }).on("error", reject);
  });

console.log(`downloading ${url}`);
await download(url);
chmodSync(target, 0o755);
console.log(`saved ${target}`);
