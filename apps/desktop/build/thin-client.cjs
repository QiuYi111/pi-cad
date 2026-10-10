const { execFileSync } = require("node:child_process");
const base = require("../package.json").build;

module.exports = {
  ...base,
  directories: { ...base.directories, output: "release-thin" },
  extraMetadata: {
    version: "0.1.4",
    reifyClientFlavor: "thin",
    reifySourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  },
  extraResources: [{ from: "build/thin-client.json", to: "thin-client.json" }],
  win: {
    ...base.win,
    artifactName: "Reify-Thin-Setup-${arch}.${ext}",
    extraResources: [{
      from: "../../executors/fusion/ReifyExport",
      to: "executors/fusion/ReifyExport",
      filter: ["**/*", "!**/__pycache__/**", "!**/*.pyc"],
    }],
  },
  portable: { ...base.portable, artifactName: "Reify-Thin-Portable-${arch}.${ext}" },
  nsis: { ...base.nsis, runAfterFinish: false },
};
