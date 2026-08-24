/** Pi-CAD is a Linux agent runtime. WSL is a supported way to run Linux. */
export function assertLinuxRuntime(where = "Pi-CAD"): void {
  if (process.platform !== "linux") {
    throw new Error(
      `${where} must run inside Linux or WSL; Windows-host Node and cross-host WSL execution are unsupported`,
    );
  }
}
