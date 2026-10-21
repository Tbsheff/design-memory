import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const SERVICE_LABEL = "dev.taste.workspace";
export const DEFAULT_SERVICE_PORT = 4781;
const HEALTH_TIMEOUT_MS = 1500;
const STARTUP_WAIT_MS = 8000;

export type ServiceConfig = { port: number; root: string };
export type PlistInput = { bun: string; main: string; root: string; port: number; log: string; path: string };

export const serviceConfigPath = (root: string) => join(root, "service.json");
export const plistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
export const serviceLogPath = (root: string) => join(root, "logs", "service.log");
const serviceUrl = (port: number) => `http://127.0.0.1:${port}`;

const xmlText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const plistString = (value: string) => `<string>${xmlText(value)}</string>`;

export function launchAgentPlist(input: PlistInput): string {
  const program = [input.bun, input.main, "--root", input.root, "open", "--port", String(input.port), "--browser", "no"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${plistString(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
${program.map(arg => `    ${plistString(arg)}`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${plistString(input.path)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key>${plistString(input.log)}
  <key>StandardErrorPath</key>${plistString(input.log)}
</dict>
</plist>
`;
}

export function readServiceConfig(root: string): ServiceConfig | undefined {
  const file = serviceConfigPath(root);
  if (!existsSync(file)) return undefined;
  const config = JSON.parse(readFileSync(file, "utf8")) as Partial<ServiceConfig>;
  return Number.isSafeInteger(config.port) && typeof config.root === "string" ? config as ServiceConfig : undefined;
}

export async function isWorkspaceUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${serviceUrl(port)}/api/stats`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.ok && "references" in (await response.json() as object);
  } catch { return false; }
}

export async function runningServiceUrl(root: string): Promise<string | undefined> {
  const config = readServiceConfig(root);
  if (!config || resolve(config.root) !== resolve(root)) return undefined;
  return await isWorkspaceUp(config.port) ? serviceUrl(config.port) : undefined;
}

const launchctl = (...args: string[]) => spawnSync("launchctl", args, { encoding: "utf8" });
const userDomain = () => `gui/${process.getuid?.() ?? 0}`;
const serviceTarget = () => `${userDomain()}/${SERVICE_LABEL}`;
const isLoaded = () => launchctl("print", serviceTarget()).status === 0;

function requireLaunchd(): void {
  if (process.platform !== "darwin") throw new Error("taste service uses macOS launchd. On other systems, run `taste open` instead.");
}

function portIsFree(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch { return false; }
}

async function waitUntilUp(port: number): Promise<boolean> {
  const deadline = Date.now() + STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isWorkspaceUp(port)) return true;
    await Bun.sleep(250);
  }
  return false;
}

export async function installService(root: string, port: number) {
  requireLaunchd();
  if (!(await isWorkspaceUp(port)) && !portIsFree(port)) throw new Error(`Port ${port} is in use by another program. Pick another with --port.`);
  const plist = plistPath();
  const log = serviceLogPath(root);
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  if (isLoaded()) launchctl("bootout", serviceTarget());
  writeFileSync(plist, launchAgentPlist({
    bun: process.execPath, main: resolve(import.meta.dir, "main.ts"), root, port, log,
    path: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  }));
  writeFileSync(serviceConfigPath(root), JSON.stringify({ port, root } satisfies ServiceConfig, null, 2));
  const started = launchctl("bootstrap", userDomain(), plist);
  if (started.status !== 0) throw new Error(`launchctl could not start the service: ${started.stderr.trim() || started.stdout.trim()}`);
  const up = await waitUntilUp(port);
  return { label: SERVICE_LABEL, url: serviceUrl(port), running: up, plist, log, ...(up ? {} : { warning: `Service did not answer yet. Check ${log}` }) };
}

export function uninstallService(root: string) {
  requireLaunchd();
  const wasLoaded = isLoaded();
  if (wasLoaded) launchctl("bootout", serviceTarget());
  const plist = plistPath();
  const hadPlist = existsSync(plist);
  rmSync(plist, { force: true });
  rmSync(serviceConfigPath(root), { force: true });
  return { label: SERVICE_LABEL, removed: wasLoaded || hadPlist };
}

export async function restartService(root: string) {
  requireLaunchd();
  const config = readServiceConfig(root);
  if (!config || !isLoaded()) throw new Error("The service is not installed. Run `taste service install`.");
  launchctl("kickstart", "-k", serviceTarget());
  const up = await waitUntilUp(config.port);
  return { label: SERVICE_LABEL, url: serviceUrl(config.port), running: up };
}

export async function serviceStatus(root: string) {
  requireLaunchd();
  const config = readServiceConfig(root);
  const loaded = isLoaded();
  const running = config ? await isWorkspaceUp(config.port) : false;
  return {
    label: SERVICE_LABEL, installed: existsSync(plistPath()), loaded, running,
    ...(config ? { url: serviceUrl(config.port) } : {}), log: serviceLogPath(root),
  };
}
