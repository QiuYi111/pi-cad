/**
 * Shell fragment that prints `<hash>  <path>` for the file named by `$1`, the
 * same shape `sha256sum` prints. Linux and WSL have `sha256sum`; macOS only has
 * `shasum -a 256`, so the fragment falls back to it. Callers run it with `sh`.
 */
export const SHA256_SHELL = 'if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1"; else shasum -a 256 -- "$1"; fi';

/** Runtime argv that prints `<hash>  <path>` for `path` on any Unix host. */
export function sha256Command(path: string): string[] {
  return ["sh", "-c", SHA256_SHELL, "sha256", path];
}
