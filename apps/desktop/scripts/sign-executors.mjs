/**
 * Optional Authenticode signing of the CAD executors that Reify bundles
 * (executors/solidworks/publish/*.exe and *.dll). Controlled by env vars:
 *
 *   REIFY_SIGN_PFX            path of a .pfx certificate   (or)
 *   REIFY_SIGN_CERT_SHA1      thumbprint of a certificate in the Windows store
 *   REIFY_SIGN_PFX_PASSWORD   password of the .pfx (optional)
 *   REIFY_SIGNTOOL            path of signtool.exe (default: signtool.exe on PATH)
 *   REIFY_SIGN_TIMESTAMP_URL  RFC 3161 server (default: http://timestamp.digicert.com)
 *   REIFY_EXECUTOR_DIR        folder to sign (default: ../../executors/solidworks/publish)
 *
 * When neither REIFY_SIGN_PFX nor REIFY_SIGN_CERT_SHA1 is set, this is a no-op.
 * The Reify app itself is signed by electron-builder (CSC_* variables).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function signtoolArguments(env, file) {
  if (!env.REIFY_SIGN_PFX && !env.REIFY_SIGN_CERT_SHA1) return null;
  const args = ["sign", "/fd", "SHA256", "/tr", env.REIFY_SIGN_TIMESTAMP_URL || "http://timestamp.digicert.com", "/td", "SHA256"];
  if (env.REIFY_SIGN_PFX) {
    args.push("/f", env.REIFY_SIGN_PFX);
    if (env.REIFY_SIGN_PFX_PASSWORD) args.push("/p", env.REIFY_SIGN_PFX_PASSWORD);
  } else args.push("/sha1", env.REIFY_SIGN_CERT_SHA1);
  args.push(file);
  return args;
}

export function signExecutors({ env = process.env, spawn = spawnSync, list = readdirSync, exists = existsSync, log = console.log } = {}) {
  if (!env.REIFY_SIGN_PFX && !env.REIFY_SIGN_CERT_SHA1) {
    log("Executor signing skipped: REIFY_SIGN_PFX and REIFY_SIGN_CERT_SHA1 are not set.");
    return [];
  }
  const directory = env.REIFY_EXECUTOR_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../../../executors/solidworks/publish");
  if (!exists(directory)) {
    log(`Executor signing skipped: ${directory} does not exist.`);
    return [];
  }
  const signed = [];
  for (const name of list(directory)) {
    if (!/\.(exe|dll)$/i.test(name)) continue;
    const file = join(directory, name);
    const result = spawn(env.REIFY_SIGNTOOL || "signtool.exe", signtoolArguments(env, file), { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`signtool failed for ${file} (exit ${result.status}).`);
    signed.push(file);
  }
  return signed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) signExecutors();
