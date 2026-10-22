import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Target } from "./lib.ts";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const TASTE_SKILL = join(homedir(), ".agents/skills/taste-use");
export const TASTE_SOURCE_HOME = process.env.DESIGN_MEMORY_HOME ?? join(homedir(), ".design-memory");

export type ClaudeResult = {
  ok: boolean;
  text: string;
  error?: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  tool_uses: ToolCall[];
  timed_out: boolean;
  raw: string;
  exit_code: number | null;
};

export type ClaudeCall = { prompt: string; cwd: string; model: string; tools: string[]; allowed: string[]; extra?: string[]; env?: Record<string, string>; timeoutMs: number; budgetUsd: number };

export function isolationArgs(call: ClaudeCall): string[] {
  return [
    "-p", call.prompt,
    "--output-format", "json", "--verbose",
    "--model", call.model,
    "--setting-sources", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--permission-mode", "acceptEdits",
    "--max-budget-usd", String(call.budgetUsd),
    "--tools", call.tools.join(","),
    "--allowedTools", call.allowed.join(","),
    ...(call.extra ?? []),
  ];
}

type Message = { type?: string; subtype?: string; result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number; num_turns?: number; message?: { content?: unknown } };
type Part = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown };
export type ToolCall = { name: string; input: unknown; ok: boolean | null; result_head: string };

function parts(messages: Message[], type: string): Part[] {
  return messages.filter(m => m.type === type && Array.isArray(m.message?.content)).flatMap(m => m.message!.content as Part[]);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => (c as { text?: string }).text ?? "").join("\n");
  return JSON.stringify(content ?? "");
}

function toolCalls(messages: Message[]): ToolCall[] {
  const results = new Map(parts(messages, "user").filter(p => p.type === "tool_result").map(p => [p.tool_use_id, p]));
  return parts(messages, "assistant").filter(p => p.type === "tool_use").map(p => {
    const r = results.get(p.id);
    return { name: p.name ?? "", input: p.input, ok: r ? !r.is_error : null, result_head: r ? resultText(r.content).slice(0, 400) : "" };
  });
}

export function parseClaudeOutput(stdout: string): Omit<ClaudeResult, "timed_out" | "exit_code" | "raw"> {
  let parsed: Message | Message[];
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, text: "", error: `unparseable claude output: ${stdout.slice(0, 300)}`, tool_uses: [] };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const result = messages.filter(m => m.type === "result").at(-1);
  if (!result) return { ok: false, text: "", error: "no result message", tool_uses: toolCalls(messages) };
  const failed = result.is_error || result.subtype !== "success";
  return {
    ok: !failed,
    text: result.result ?? "",
    error: failed ? `${result.subtype}: ${(result.result ?? "").slice(0, 300)}` : undefined,
    cost_usd: result.total_cost_usd,
    duration_ms: result.duration_ms,
    num_turns: result.num_turns,
    tool_uses: toolCalls(messages),
  };
}

export async function runClaude(call: ClaudeCall): Promise<ClaudeResult> {
  const proc = Bun.spawn(["claude", ...isolationArgs(call)], {
    cwd: call.cwd,
    env: { ...process.env, ...call.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, call.timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const parsed = parseClaudeOutput(stdout);
  const error = timedOut ? `timed out after ${call.timeoutMs} ms` : parsed.error ?? (exitCode ? `exit ${exitCode}: ${stderr.slice(0, 300)}` : undefined);
  return { ...parsed, ok: parsed.ok && !timedOut, error, timed_out: timedOut, exit_code: exitCode, raw: stdout };
}

export async function run(cmd: string[], cwd?: string): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout: new Uint8Array(stdout), stderr };
}

export async function imageSize(path: string): Promise<{ width: number; height: number }> {
  const out = await run(["magick", "identify", "-format", "%w %h", path]);
  const [w, h] = new TextDecoder().decode(out.stdout).trim().split(" ").map(Number);
  if (!w || !h) throw new Error(`cannot read size of ${path}: ${out.stderr}`);
  return { width: w, height: h };
}

export async function renderPage(html: string, png: string, width: number, height: number): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), "bench-chrome-"));
  try {
    const out = await run([
      CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
      "--force-device-scale-factor=1", `--window-size=${width},${height}`, "--virtual-time-budget=10000",
      `--user-data-dir=${profile}`, `--screenshot=${png}`, `file://${html}`,
    ]);
    if (!existsSync(png)) throw new Error(`chrome wrote no screenshot (exit ${out.code}): ${out.stderr.slice(-300)}`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const size = await imageSize(png);
  if (size.width !== width || size.height !== height) throw new Error(`screenshot is ${size.width}x${size.height}, expected ${width}x${height}`);
}

export function statusId(url: string): string | null {
  return url.match(/status\/(\d+)/)?.[1] ?? null;
}

type LeakRow = { rowid: number; id: string; data: string };

function leakedMedia(rows: LeakRow[]): Set<string> {
  const files = new Set<string>();
  for (const row of rows) {
    const media = (JSON.parse(row.data).media ?? []) as { path?: string; thumbnail?: string }[];
    for (const m of media) for (const p of [m.path, m.thumbnail]) if (p) files.add(p);
  }
  return files;
}

function copyDirExcept(from: string, to: string, prefix: string, skip: Set<string>) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) if (!skip.has(`${prefix}/${name}`)) cpSync(join(from, name), join(to, name));
}

export async function sanitizedTasteHome(dest: string, targets: Target[]) {
  mkdirSync(dest, { recursive: true });
  const db = join(dest, "library.sqlite3");
  const vacuum = await run(["sqlite3", join(TASTE_SOURCE_HOME, "library.sqlite3"), `VACUUM INTO '${db.replaceAll("'", "''")}'`]);
  if (vacuum.code !== 0) throw new Error(`taste snapshot failed: ${vacuum.stderr}`);
  const ids = targets.map(t => statusId(t.source_url)).filter((x): x is string => !!x);
  const conn = new Database(db);
  const rows = ids.flatMap(id => conn.query("SELECT rowid,id,data FROM refs WHERE source_key LIKE ?").all(`%/status/${id}%`) as LeakRow[]);
  const tx = conn.transaction(() => {
    for (const row of rows) {
      conn.query("DELETE FROM refs_fts WHERE rowid=?").run(row.rowid);
      for (const table of ["observations", "feedback", "ref_projects"]) conn.query(`DELETE FROM ${table} WHERE ref_id=?`).run(row.id);
      conn.query("DELETE FROM refs WHERE rowid=?").run(row.rowid);
    }
  });
  tx();
  const leftover = ids.map(id => (conn.query("SELECT count(*) AS n FROM preferences WHERE data LIKE ?").get(`%${id}%`) as { n: number }).n).reduce((a, b) => a + b, 0);
  conn.close();
  const skip = leakedMedia(rows);
  copyDirExcept(join(TASTE_SOURCE_HOME, "media"), join(dest, "media"), "media", skip);
  copyDirExcept(join(TASTE_SOURCE_HOME, "thumbs"), join(dest, "thumbs"), "thumbs", skip);
  return { removed_refs: rows.map(r => r.id), removed_files: skip.size, preferences_mentioning_targets: leftover };
}

export function tastePlugin(dir: string): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "bench-taste", version: "0.0.1", description: "Only the taste-use skill, for the design rebuild benchmark" }));
  const skill = join(dir, "skills/taste-use");
  if (!existsSync(skill)) cpSync(TASTE_SKILL, skill, { recursive: true, dereference: true });
  return skill;
}
