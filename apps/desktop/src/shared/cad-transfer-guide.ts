/**
 * User-facing text of the "CAD exports" setup guide.
 *
 * One file holds all text. The Settings page, the Workbench tooltips and
 * docs/cad-transfer/README.md use it. Style: ASD-STE100 Simplified Technical
 * English. One instruction in each sentence. Active voice. Short sentences.
 */
import type { CadTransferState, CadTransferTarget } from "./contracts.js";

export const CAD_EXPORTS_TITLE = "CAD exports";
export const CAD_EXPORTS_INTRO = "Send a Reify part or assembly to Autodesk Fusion or SolidWorks. Reify builds it again in the CAD program. It then checks that the new shape is the same.";

export const FUSION_GUIDE = {
  title: "Autodesk Fusion",
  steps: [
    "Install Autodesk Fusion on this computer.",
    "Click Install add-in. Reify copies the ReifyExport add-in into Fusion.",
    "Start Fusion. If Fusion is open, close it and start it again.",
    "In Fusion, open Utilities, then Add-Ins. On the Add-Ins tab, select ReifyExport. Click Run. Turn on Run on Startup.",
    "Sign in to Fusion. Then click Test export.",
  ],
  installButton: "Install add-in",
  updateButton: "Update add-in",
  runningLabel: "Add-in running",
  notRunningLabel: "Add-in not running",
  installedVersionLabel: "Installed add-in version",
} as const;

export const SOLIDWORKS_GUIDE = {
  title: "SolidWorks",
  steps: [
    "Install SolidWorks 2022 or a newer version. SolidWorks must run on Windows.",
    "Start SolidWorks one time. Wait until SolidWorks is fully open. Then you can close it.",
    "Click Test export. Reify starts the ReifyExport program that comes with Reify.",
  ],
  minimumVersionText: "Minimum supported version: SolidWorks 2022.",
  wslNote: "Reify runs in WSL. The CAD program runs on Windows. Reify copies the project files across. You do not need to change any path.",
  wslOnlyNote: "SolidWorks exports need Reify for Windows. This copy of Reify runs inside WSL and cannot start Windows programs.",
} as const;

export const TEST_EXPORT_GUIDE = {
  button: "Test export",
  running: "Test export is running.",
  description: "Test export builds a reference plate. The plate is 40 by 30 by 5 mm. It has 4 through holes and 1 pocket. Reify sends the plate to the CAD program and checks the result.",
  passed: "Test export passed.",
  failed: "Test export failed.",
  logLabel: "Log file",
} as const;

export const WORKBENCH_TEXT = {
  exportFusion: "Export to Fusion",
  exportSolidworks: "Export to SolidWorks",
  setupLink: "Set up in Settings",
  running: "Exporting.",
  queued: "Waiting for the CAD program.",
  openFolder: "Open folder",
  cancel: "Cancel",
  disabledTitle: (name: string, detail: string) => `${name} is not ready. ${detail} Open Settings, then CAD exports.`,
} as const;

/** Short sentence for each target state. */
export const STATE_TEXT: Record<CadTransferTarget, Record<CadTransferState, string>> = {
  fusion: {
    ready: "Ready. Fusion and the add-in are running.",
    not_installed: "Fusion is not installed.",
    addin_missing: "The add-in is not installed. Click Install add-in.",
    addin_not_running: "The add-in is not running. Start Fusion and run the ReifyExport add-in.",
    executor_missing: "The export program is missing. Install Reify again.",
    unsupported_platform: "Fusion exports are not available on this system.",
    unavailable: "The export service is not running. Start a project.",
  },
  solidworks: {
    ready: "Ready. SolidWorks and the export program are installed.",
    not_installed: "SolidWorks 2022 or newer is not installed.",
    addin_missing: "The export program is not installed.",
    addin_not_running: "The export program is not running.",
    executor_missing: "The export program is missing. Install Reify again.",
    unsupported_platform: "SolidWorks exports work on Windows only.",
    unavailable: "The export service is not running. Start a project.",
  },
};

export const TARGET_NAME: Record<CadTransferTarget, string> = { fusion: "Fusion", solidworks: "SolidWorks" };
