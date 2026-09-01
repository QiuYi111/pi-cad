/** Pi-CAD requires Unix process, socket, and filesystem semantics. */
export function assertUnixRuntime(where = "Pi-CAD"): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(
      `${where} must run on Linux, macOS, or Linux through WSL`,
    );
  }
}

export const assertLinuxRuntime = assertUnixRuntime;
