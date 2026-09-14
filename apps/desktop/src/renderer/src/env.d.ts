import type { DesktopApi } from "../../shared/contracts";

declare global {
  interface Window { piCad: DesktopApi }
}

export {};
