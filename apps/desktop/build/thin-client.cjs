const { execFileSync } = require("node:child_process");

module.exports = {
  directories: { output: "release-thin" },
  extraMetadata: {
    version: "0.1.1",
    reifyClientFlavor: "thin",
    reifySourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  },
  extraResources: [{ from: "build/thin-client.json", to: "thin-client.json" }],
  win: { artifactName: "Reify-Thin-Setup-${arch}.${ext}" },
  portable: { artifactName: "Reify-Thin-Portable-${arch}.${ext}" },
  nsis: { runAfterFinish: false },
};
