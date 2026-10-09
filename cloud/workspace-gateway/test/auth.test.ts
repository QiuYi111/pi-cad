import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createTokenVerifier } from "../src/auth.js";

const WORKSPACE = "ws-test";

async function setup() {
  const pair = await generateKeyPair("ES256");
  const verify = await createTokenVerifier({ publicKeyPem: await exportSPKI(pair.publicKey), workspaceName: WORKSPACE });
  // iat and exp are given in seconds; the verifier reads the real clock.
  const mint = (claims: { iat?: number; exp?: number | null; ws?: string } = {}) => {
    const builder = new SignJWT({ ws: claims.ws ?? WORKSPACE })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("user-1")
      .setAudience("ws-gateway");
    const now = Math.floor(Date.now() / 1000);
    builder.setIssuedAt(claims.iat ?? now);
    if (claims.exp !== null) builder.setExpirationTime(claims.exp ?? now + 60);
    return builder.sign(pair.privateKey);
  };
  return { verify, mint };
}

describe("gateway token verifier", () => {
  it("accepts a fresh 60 s token for this workspace", async () => {
    const { verify, mint } = await setup();
    expect(await verify(await mint())).toBe(true);
  });

  it("rejects a token issued more than 120 s ago", async () => {
    const { verify, mint } = await setup();
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(await mint({ iat: now - 121, exp: now + 60 }))).toBe(false);
  });

  it("rejects a token whose lifetime is longer than 120 s", async () => {
    const { verify, mint } = await setup();
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(await mint({ iat: now, exp: now + 3600 }))).toBe(false);
  });

  it("rejects a token without exp", async () => {
    const { verify, mint } = await setup();
    expect(await verify(await mint({ exp: null }))).toBe(false);
  });

  it("rejects a token for another workspace", async () => {
    const { verify, mint } = await setup();
    expect(await verify(await mint({ ws: "ws-other" }))).toBe(false);
  });
});
