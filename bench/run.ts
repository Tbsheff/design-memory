import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPrompt, parseRunArgs, selectTargets, timestamp, viewportFor } from "./lib.ts";
import type { Mode, RunOptions, Target } from "./lib.ts";
import { readJson, splitJobs } from "./resume.ts";
import { renderPage, runClaude, sanitizedTasteHome, tastePlugin } from "./tools.ts";
import type { ClaudeCall, ClaudeResult } from "./tools.ts";

export const BENCH = import.meta.dir;

export function loadTargets(): Target[] {
  return JSON.parse(readFileSync(join(BENCH, "targets.json"), "utf8"));
}

type Job = { target: Target; mode: Mode; sample: number };
type Context = { out: string; options: RunOptions; tasteHome: string; plugin: string; skillDir: string };

export type RunInfo = { out: string; cost_usd: number; builds: number; failed: number };

const BASE_TOOLS = ["Read", "Write", "Edit", "Skill"];
const TASTE_TOOLS = ["Write", "Edit", "Skill"];
const TASTE_BASH = ["Bash(taste *)", "Bash(*/scripts/taste *)"];
const HOOK = join(BENCH, "taste-hook.ts");

function tasteExtra(ctx: Context): string[] {
  const hooks = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `bun ${JSON.stringify(HOOK)}` }] }] } };
  return ["--plugin-dir", ctx.plugin, "--add-dir", ctx.plugin, "--settings", JSON.stringify(hooks)];
}

export function tasteReadRules(tasteHome: string): string[] {
  return ["media", "thumbs"].map(dir => `Read(/${join(tasteHome, dir)}/**)`);
}

function callFor(job: Job, ctx: Context, cwd: string): ClaudeCall {
  const taste = job.mode === "taste";
  return {
    prompt: buildPrompt(job.target, job.mode),
    cwd,
    model: ctx.options.model,
    tools: taste ? [...BASE_TOOLS, "Bash"] : BASE_TOOLS,
    allowed: taste ? [...TASTE_TOOLS, ...tasteReadRules(ctx.tasteHome), ...TASTE_BASH] : BASE_TOOLS,
    extra: taste ? tasteExtra(ctx) : [],
    env: { DESIGN_MEMORY_HOME: ctx.tasteHome, TASTE_HOOK_DIRS: ctx.skillDir },
    timeoutMs: ctx.options.timeoutMinutes * 60_000,
    budgetUsd: ctx.options.budgetUsd,
  };
}

function findHtml(cwd: string): string | null {
  if (existsSync(join(cwd, "index.html"))) return join(cwd, "index.html");
  const any = readdirSync(cwd).find(f => f.endsWith(".html"));
  return any ? join(cwd, any) : null;
}

const TASTE_OUTPUT = /Design Memory profile|# Design brief|ref_[0-9a-f]{6}|"id": "ref_/;

function tasteUsage(result: ClaudeResult) {
  const skills = result.tool_uses.filter(u => u.name === "Skill").map(u => String((u.input as { skill?: string })?.skill ?? ""));
  const bash = result.tool_uses.filter(u => u.name === "Bash").map(u => ({ command: String((u.input as { command?: string })?.command ?? ""), ok: u.ok, result_head: u.result_head.slice(0, 200) }));
  const taste = bash.filter(b => /\btaste\b/.test(b.command));
  const images = result.tool_uses.filter(u => u.name === "Read" && /\/(media|thumbs)\//.test(String((u.input as { file_path?: string })?.file_path ?? "")));
  return {
    image_reads: images.length,
    image_reads_ok: images.filter(u => u.ok).length,
    skills_used: skills,
    skill_used: skills.some(s => s.includes("taste-use")),
    taste_calls: taste.length,
    taste_ok_calls: taste.filter(b => b.ok && TASTE_OUTPUT.test(b.result_head)).length,
    bash: bash.map(b => ({ ...b, command: b.command.slice(0, 300) })),
  };
}

async function renderInto(dir: string, target: Target): Promise<string | undefined> {
  const { width, height } = viewportFor(target);
  try {
    await renderPage(join(dir, "index.html"), join(dir, "build.png"), width, height);
    return undefined;
  } catch (e) {
    return `render failed: ${(e as Error).message}`;
  }
}

function jobDir(out: string, job: Job): string {
  return join(out, job.target.id, job.mode, String(job.sample));
}

const jobKey = (job: Job) => ({ target: job.target.id, mode: job.mode, sample: job.sample });

async function build(job: Job, ctx: Context): Promise<Record<string, unknown>> {
  const dir = jobDir(ctx.out, job);
  mkdirSync(dir, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "design-bench-"));
  if (job.mode === "reference") copyFileSync(join(BENCH, job.target.image), join(cwd, "reference.jpg"));
  const started = Date.now();
  const result = await runClaude(callFor(job, ctx, cwd));
  const html = findHtml(cwd);
  if (html) copyFileSync(html, join(dir, "index.html"));
  rmSync(cwd, { recursive: true, force: true });
  const renderError = html ? await renderInto(dir, job.target) : "no html file written";
  const meta = {
    target: job.target.id, mode: job.mode, sample: job.sample, model: ctx.options.model,
    ok: !!html && !renderError, claude_ok: result.ok, error: renderError ?? result.error,
    cost_usd: result.cost_usd, duration_ms: result.duration_ms, wall_ms: Date.now() - started, num_turns: result.num_turns,
    timed_out: result.timed_out, tool_counts: countTools(result), tool_errors: result.tool_uses.filter(u => u.ok === false).map(u => `${u.name}: ${u.result_head.slice(0, 160)}`), ...tasteUsage(result),
    html_name: html ? html.split("/").at(-1) : null, final_text: result.text.slice(0, 1000),
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, "transcript.json"), result.raw);
  return meta;
}

function countTools(result: ClaudeResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of result.tool_uses) counts[u.name] = (counts[u.name] ?? 0) + 1;
  return counts;
}

export async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function jobsFor(targets: Target[], options: RunOptions): Job[] {
  return targets.flatMap(target => options.modes.flatMap(mode => Array.from({ length: options.samples }, (_, i) => ({ target, mode, sample: i + 1 }))));
}

type Sanitized = Awaited<ReturnType<typeof sanitizedTasteHome>>;

async function tasteHomeFor(out: string, tasteHome: string, resume: boolean): Promise<Sanitized> {
  if (!resume || !existsSync(join(tasteHome, "library.sqlite3"))) return sanitizedTasteHome(tasteHome, loadTargets());
  const prior = readJson<{ taste_home?: Sanitized }>(join(out, "run.json"))?.taste_home;
  return prior ?? { removed_refs: [], removed_files: 0, preferences_mentioning_targets: 0 };
}

export async function runBench(options: RunOptions, targets: Target[], quiet = false, resume = false): Promise<RunInfo> {
  const out = resolve(options.out ?? join(BENCH, "runs", timestamp()));
  mkdirSync(join(out, "targets"), { recursive: true });
  for (const t of targets) copyFileSync(join(BENCH, t.image), join(out, "targets", `${t.id}.jpg`));
  const tasteHome = join(out, ".taste-home");
  const sanitize = await tasteHomeFor(out, tasteHome, resume);
  const plugin = join(out, ".taste-plugin");
  const ctx: Context = { out, options, tasteHome, plugin, skillDir: tastePlugin(plugin, options.skillDir ? resolve(options.skillDir) : null, resume) };
  const all = jobsFor(targets, options);
  const split = resume ? splitJobs(all, jobKey, job => readJson<Record<string, unknown>>(join(jobDir(out, job), "meta.json"))) : { reuse: [], todo: all };
  const jobs = split.todo;
  const started = new Date();
  const log = (line: string) => { if (!quiet) console.log(line); };
  log(`run ${out}: ${jobs.length} builds (${split.reuse.length} reused), concurrency ${options.concurrency}, taste refs removed: ${sanitize.removed_refs.length}`);
  let done = 0;
  const built = await pool(jobs, options.concurrency, async job => {
    const meta = await build(job, ctx);
    log(`[${++done}/${jobs.length}] ${job.target.id} ${job.mode} #${job.sample} ${meta.ok ? "ok" : `FAILED ${meta.error}`} $${Number(meta.cost_usd ?? 0).toFixed(2)}`);
    return meta;
  });
  const metas = [...split.reuse.map(r => r.meta), ...built];
  const finished = new Date();
  const run = { started: started.toISOString(), finished: finished.toISOString(), wall_ms: finished.getTime() - started.getTime(), options, targets: targets.map(t => t.id), taste_home: sanitize, builds: metas.length, failed: metas.filter(m => !m.ok).length, cost_usd: metas.reduce((a, m) => a + Number(m.cost_usd ?? 0), 0) };
  writeFileSync(join(out, "run.json"), JSON.stringify(run, null, 2));
  log(`done in ${Math.round(run.wall_ms / 1000)} s, ${run.failed} failed, $${run.cost_usd.toFixed(2)}. Next: bun bench/score.ts --run ${out}`);
  return { out, cost_usd: run.cost_usd, builds: run.builds, failed: run.failed };
}

async function main() {
  const options = parseRunArgs(process.argv.slice(2));
  await runBench(options, selectTargets(loadTargets(), options.targets));
}

if (import.meta.main) await main();
