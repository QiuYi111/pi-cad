import { describe, expect, it } from "vitest";
import { NativeBridge } from "../electron/main/native";

describe("native desktop runtime", () => {
  it("uses the Electron executable as the bundled Node runtime", async () => {
    const bridge = new NativeBridge("/opt/pi-cad/runtime", "/Applications/Reify.app/Contents/MacOS/Reify");
    await expect(bridge.commandPath("node")).resolves.toMatch(/\/pi-cad-desktop\/bin\/node$/);
  });

  it("keeps native project paths native", async () => {
    const bridge = new NativeBridge();
    await expect(bridge.toRuntimePath("/tmp/project/model.step")).resolves.toBe("/tmp/project/model.step");
    await expect(bridge.revealPath("/tmp/project/model.step")).resolves.toBe("/tmp/project/model.step");
  });

  it("pipes request bodies to native commands", async () => {
    const bridge = new NativeBridge();
    await expect(bridge.pipe(["/bin/sh", "-c", "cat"], "model request\n"))
      .resolves.toEqual({ stdout: "model request\n", stderr: "" });
  });
});
