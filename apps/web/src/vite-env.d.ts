/// <reference types="vite/client" />

import type { DesktopBridge, LocalApi } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly APP_VERSION: string;
  readonly VITE_CONTENT_STUDIO?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_LAUNCHPAD_URL?: string;
  readonly VITE_WORKSPACE_ROOT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
  }
}
