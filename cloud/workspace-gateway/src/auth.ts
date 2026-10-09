import { importSPKI, jwtVerify } from "jose";

export const GATEWAY_TOKEN_HEADER = "x-reify-gateway-token";

export type TokenVerifier = (token: string) => Promise<boolean>;

// Gateway tokens live 60 s (plan 7.2). Anything older than this, or without exp and iat, is rejected.
export const GATEWAY_MAX_TOKEN_AGE = "120s";
export const GATEWAY_MAX_LIFETIME_SEC = 120;

// Accepts ES256 gateway tokens with aud=ws-gateway, exp and iat, at most 120 s old, and ws=<workspace name>.
export async function createTokenVerifier(options: { publicKeyPem: string; workspaceName: string }): Promise<TokenVerifier> {
  const key = await importSPKI(options.publicKeyPem, "ES256");
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key, {
        audience: "ws-gateway",
        algorithms: ["ES256"],
        requiredClaims: ["exp", "iat"],
        maxTokenAge: GATEWAY_MAX_TOKEN_AGE,
      });
      // maxTokenAge limits the age of iat only. Also limit the lifetime, exp - iat.
      if ((payload.exp as number) - (payload.iat as number) > GATEWAY_MAX_LIFETIME_SEC) return false;
      return payload.ws === options.workspaceName;
    } catch {
      return false;
    }
  };
}
