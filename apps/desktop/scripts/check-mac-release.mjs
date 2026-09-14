const required = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
const missing = required.filter((name) => !process.env[name]);
if (process.platform !== "darwin") throw new Error("macOS packages must be produced and verified on macOS.");
if (missing.length) throw new Error(`macOS release blocked: missing signing/notarization credentials: ${missing.join(", ")}`);
process.stdout.write("macOS signing and notarization credentials are present; electron-builder will submit the signed application.\n");
