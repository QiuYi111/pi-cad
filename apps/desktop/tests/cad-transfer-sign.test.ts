import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM script without types
import { signExecutors, signtoolArguments } from "../scripts/sign-executors.mjs";

describe("executor signing hook", () => {
  it("does nothing when no certificate variable is set", () => {
    const spawn = vi.fn();
    expect(signExecutors({ env: {}, spawn, log: () => undefined })).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("signs every exe and dll with signtool when a certificate is set", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const signed = signExecutors({
      env: { REIFY_SIGN_PFX: "c.pfx", REIFY_SIGN_PFX_PASSWORD: "pw", REIFY_EXECUTOR_DIR: "/x" },
      spawn, list: () => ["ReifyExport.exe", "a.dll", "a.pdb"], exists: () => true, log: () => undefined,
    });
    expect(signed).toHaveLength(2);
    expect(spawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(["sign", "/f", "c.pfx", "/p", "pw"]));
  });
  it("uses the certificate thumbprint when there is no pfx, and fails on a signtool error", () => {
    expect(signtoolArguments({ REIFY_SIGN_CERT_SHA1: "ab" }, "f.exe")).toEqual(expect.arrayContaining(["/sha1", "ab", "f.exe"]));
    expect(() => signExecutors({
      env: { REIFY_SIGN_CERT_SHA1: "ab", REIFY_EXECUTOR_DIR: "/x" }, spawn: () => ({ status: 1 }), list: () => ["a.exe"], exists: () => true, log: () => undefined,
    })).toThrow(/signtool failed/);
  });
});
