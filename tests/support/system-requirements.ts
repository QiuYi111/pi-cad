// Real-system gate. A test that needs a system listed for its area in
// tests/areas.yaml passes its availability here:
//   - the system is available: returns false (run the test);
//   - missing and REIFY_REQUIRE_<SYSTEM>=1 (CI sets it for the systems it installs):
//     throws, so the run fails instead of passing without the test;
//   - missing otherwise (a local run): returns the skip reason.
export function systemSkip(system: string, available: boolean, reason: string): string | false {
  if (available) return false;
  const variable = `REIFY_REQUIRE_${system.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  if (process.env[variable] === "1") throw new Error(`${system} is required (${variable}=1) but unavailable: ${reason}`);
  return reason;
}
