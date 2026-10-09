import { importSPKI, jwtVerify } from "jose";

export const GATEWAY_TOKEN_HEADER = "x-reify-gateway-token";

export type TokenVerifier = (token: string) => Promise<boolean>;

// Accepts ES256 gateway tokens with aud=ws-gateway and ws=<workspace name>.
export async function createTokenVerifier(options: { publicKeyPem: string; workspaceName: string }): Promise<TokenVerifier> {
  const key = await importSPKI(options.publicKeyPem, "ES256");
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key, { audience: "ws-gateway", algorithms: ["ES256"] });
      return payload.ws === options.workspaceName;
    } catch {
      return false;
    }
  };
}
