export const PROXY_URL_ENVIRONMENT = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

// Removes `user:password@` from a scheme://authority proxy URL, keeping scheme,
// host, port and path. Values without a scheme are not URLs and pass unchanged.
export function stripProxyUserinfo(value: string): { value: string; stripped: boolean } {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/.exec(value);
  if (!match) return { value, stripped: false };
  return { value: `${match[1]}${value.slice(match[0].length)}`, stripped: true };
}

export function warnProxyCredentialsStripped(): void {
  process.stderr.write("[pi-cad] warning: authenticated proxy credentials are not forwarded to the Prime sandbox; the proxy URL was passed without user:password\n");
}
