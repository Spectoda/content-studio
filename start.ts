/**
 * Content Studio launcher — starts the server + web app in Content Studio mode.
 * Designed to be invoked from the content app's "Start Studio" button.
 *
 * Spawns two processes in parallel:
 *   1. Content Studio server (port 3774) — orchestration, provider sessions, WebSocket RPC
 *   2. Content Studio web/Vite (port 5290) — Content Studio UI
 *
 * This file lives inside the content-studio submodule.
 */
import { join, dirname, resolve } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";

// content/studio/ is the submodule root, which IS the t3code root
const studioRoot = import.meta.dir;
const contentRoot = dirname(studioRoot);
const workspaceRoot = dirname(contentRoot);
const serverDir = join(studioRoot, "apps", "server");
const webDir = join(studioRoot, "apps", "web");
const bunPath = process.execPath;

const SERVER_PORT = 3774;
const WEB_PORT = 5290;

// Ensure provider CLIs (codex, claude) are on PATH even when launched from Astro integration
const homedir = process.env.HOME ?? "/Users/" + process.env.USER;
const nvmDir = join(homedir, ".nvm", "versions", "node");
let nvmBin = "";
if (existsSync(nvmDir)) {
  try {
    const versions = execSync(`ls -1 "${nvmDir}"`, { encoding: "utf8" }).trim().split("\n");
    const latest = versions
      .filter((v) => v.startsWith("v"))
      .sort()
      .pop();
    if (latest) nvmBin = join(nvmDir, latest, "bin");
  } catch {}
}

const extraPaths = [
  join(homedir, ".superset", "bin"),
  nvmBin,
  join(homedir, ".bun", "bin"),
  join(homedir, ".local", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
].filter((p) => p && existsSync(p));
const enrichedPath = [...extraPaths, process.env.PATH ?? ""].join(":");

console.log(`[Content Studio] Studio root: ${studioRoot}`);
console.log(`[Content Studio] Workspace root: ${workspaceRoot}`);

if (!existsSync(serverDir)) {
  console.error(`[Content Studio] ERROR: server not found at ${serverDir}`);
  process.exit(1);
}
if (!existsSync(webDir)) {
  console.error(`[Content Studio] ERROR: web not found at ${webDir}`);
  process.exit(1);
}

// --- Reclaim ports from stale processes ---
function reclaimPort(port: number) {
  try {
    const output = execSync(`lsof -ti:${port}`, { encoding: "utf8" }).trim();
    if (output) {
      const pids = output
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
      console.log(`[Content Studio] Reclaiming port ${port} from PIDs: ${pids.join(", ")}`);
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid}`, { stdio: "ignore" });
        } catch {}
      }
      execSync("sleep 1", { stdio: "ignore" });
    }
  } catch {}
}

reclaimPort(SERVER_PORT);
reclaimPort(WEB_PORT);

// --- Start BOTH processes in parallel ---
console.log(
  `[Content Studio] Starting server (port ${SERVER_PORT}) and web (port ${WEB_PORT}) in parallel...`,
);

const serverProc = Bun.spawn(
  [
    bunPath,
    "run",
    "src/bin.ts",
    workspaceRoot,
    "--mode",
    "web",
    "--port",
    String(SERVER_PORT),
    "--no-browser",
    "--auto-bootstrap-project-from-cwd",
  ],
  {
    cwd: serverDir,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PATH: enrichedPath,
      T3CODE_MODE: "web",
      T3CODE_PORT: String(SERVER_PORT),
      VITE_CONTENT_STUDIO: "true",
      CONTENT_EDITOR_URL: `http://localhost:55279`,
      CONTENT_MANIFEST_PATH: resolve(contentRoot, "app/v1/generated/content-manifest.json"),
    },
  },
);

const webProc = Bun.spawn([bunPath, "run", "vite", "--port", String(WEB_PORT), "--strictPort"], {
  cwd: webDir,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    VITE_CONTENT_STUDIO: "true",
    VITE_WS_URL: `ws://localhost:${SERVER_PORT}/ws`,
    VITE_LAUNCHPAD_URL: `http://localhost:${process.env.LAUNCHPAD_PORT ?? "8888"}`,
    VITE_WORKSPACE_ROOT: workspaceRoot,
    PORT: String(WEB_PORT),
  },
});

// Cleanup: kill both process trees
function killTree(pid: number) {
  try {
    execSync(`pkill -9 -P ${pid}`, { stdio: "ignore" });
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

const cleanup = () => {
  killTree(webProc.pid);
  killTree(serverProc.pid);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

serverProc.exited.then((code) => {
  console.log(`[Content Studio] Server process exited (code ${code})`);
  cleanup();
});

webProc.exited.then((code) => {
  console.log(`[Content Studio] Web process exited (code ${code})`);
  cleanup();
});

await Promise.race([serverProc.exited, webProc.exited]);
