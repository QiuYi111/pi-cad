import { describe, expect, it } from "vitest";
import { NativeBridge } from "../electron/main/native";

describe("native desktop runtime", () => {
  it("uses the Electron executable as the bundled Node runtime", async () => {
    const bridge = new NativeBridge("/opt/pi-cad/runtime", "/Applications/Pi-CAD.app/Contents/MacOS/Pi-CAD");
    await expect(bridge.commandPath("node")).resolves.toMatch(/\/pi-cad-desktop\/bin\/node$/);
  });

  it("keeps native project paths native", async () => {
    const bridge = new NativeBridge();
    await expect(bridge.toRuntimePath("/tmp/project/model.step")).resolves.toBe("/tmp/project/model.step");
    await expect(bridge.revealPath("/tmp/project/model.step")).resolves.toBe("/tmp/project/model.step");
  });
});
