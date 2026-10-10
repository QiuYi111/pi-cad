import { Agent } from "undici";

// Tailnet HTTPS endpoints must use the local Tailscale route. Sending them to
// an inherited HTTP proxy can fail TLS before the API receives any request.
const directCloudDispatcher = new Agent();

export function bypassCloudProxy(hostname: string): boolean {
  return hostname.endsWith(".ts.net") || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export const cloudFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  const requestInit = bypassCloudProxy(url.hostname) ? { ...init, dispatcher: directCloudDispatcher } : init;
  return fetch(input, requestInit);
};
