const PROXY_KEYS = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "ELECTRON_GET_USE_PROXY",
];

export function forwardWslInteropEnvironment(source) {
  const entries = (source.WSLENV || "").split(":").filter(Boolean);
  const present = new Set(entries.map((entry) => entry.split("/")[0]));
  for (const key of PROXY_KEYS) {
    if (source[key] !== undefined && !present.has(key)) entries.push(key);
  }
  return { ...source, WSLENV: entries.join(":") };
}
