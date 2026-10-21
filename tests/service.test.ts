import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { store } from "../src/db.ts";
import { startApp } from "../src/app.ts";
import { launchAgentPlist, runningServiceUrl, serviceConfigPath, SERVICE_LABEL } from "../src/service.ts";

let root = "", db: ReturnType<typeof store>, server: ReturnType<typeof startApp>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "taste-service-"));
  db = store(root);
  server = startApp(root, db, { launch: false, port: 0 });
});
afterEach(async () => { await server.stop(true); db.close(true); rmSync(root, { recursive: true, force: true }); });

const getWithHost = (port: number, host: string, path: string) => new Promise<number>((done, fail) => {
  const req = request({ hostname: "127.0.0.1", port, path, headers: { host } }, res => { res.resume(); done(res.statusCode ?? 0); });
  req.on("error", fail);
  req.end();
});

describe("background service", () => {
  test("the launch agent runs the workspace on a fixed port with escaped paths", () => {
    const plist = launchAgentPlist({ bun: "/opt/bun", main: "/app/src/main.ts", root: "/Users/a&b/.design-memory", port: 4781, log: "/tmp/log<1>", path: "/usr/bin" });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<string>/Users/a&amp;b/.design-memory</string>");
    expect(plist).toContain("<string>/tmp/log&lt;1&gt;</string>");
    const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]);
    expect(args).toEqual(expect.arrayContaining(["open", "--port", "4781", "--browser", "no"]));
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });

  test("taste open reuses a running service for the same library only", async () => {
    writeFileSync(serviceConfigPath(root), JSON.stringify({ port: server.port, root }));
    expect(await runningServiceUrl(root)).toBe(`http://127.0.0.1:${server.port}`);
    writeFileSync(serviceConfigPath(root), JSON.stringify({ port: server.port, root: "/some/other/library" }));
    expect(await runningServiceUrl(root)).toBeUndefined();
  });

  test("a stopped service is not reused", async () => {
    const port = server.port!;
    await server.stop(true);
    writeFileSync(serviceConfigPath(root), JSON.stringify({ port, root }));
    expect(await runningServiceUrl(root)).toBeUndefined();
  });

  test("requests with a foreign Host header are refused, blocking DNS rebinding reads", async () => {
    const port = server.port!;
    expect(await getWithHost(port, `127.0.0.1:${port}`, "/api/list")).toBe(200);
    expect(await getWithHost(port, `evil.example:${port}`, "/api/list")).toBe(403);
    expect(await getWithHost(port, `evil.example:${port}`, "/")).toBe(403);
    expect(await getWithHost(port, `localhost:${port}`, "/api/stats")).toBe(403);
  });
});

describe("brand", () => {
  test("the workspace page shows the SVG logo and a tab icon", async () => {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    expect(html).toContain('class="brandmark"><svg');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
    expect(html).not.toContain('class="brandmark">✳');
    expect(html).toContain('class="emptyart"><svg');
    expect(html).not.toContain('class="emptyicon">✳');
  });
});
