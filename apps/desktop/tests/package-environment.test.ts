import { describe, expect, it } from "vitest";
import { forwardWslInteropEnvironment } from "../scripts/wsl-interop-environment.mjs";

describe("Windows packaging environment", () => {
  it("forwards proxy settings through WSL interop", () => {
    const result = forwardWslInteropEnvironment({
      WSLENV: "EXISTING/u",
      EXISTING: "keep",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
    });
    expect(result.WSLENV).toBe("EXISTING/u:HTTPS_PROXY:http_proxy");
    expect(result.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });
});
