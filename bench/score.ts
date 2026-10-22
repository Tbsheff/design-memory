import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { colorHistogram, histogramDistance, JUDGE_PROMPT, JUDGE_SCALE, parseJudgement, parseScoreArgs, round, ssimFromPixels, summarize } from "./lib.ts";
import type { BuildMeta, BuildScore, Judgement, RuleSummary, ScoreOptions, Target } from "./lib.ts";
import { buildObjective, parseProfileRules, parseRuleJudgement, prepareHtml, ruleJudgePrompt } from "./objective.ts";
import { readJson } from "./resume.ts";
import { loadTargets, pool } from "./run.ts";
import { run, runClaude, TASTE_SKILL } from "./tools.ts";

const COMPARE_WIDTH = 720;

export function buildDirs(out: string): string[] {
  const dirs: string[] = [];
  for (const target of readdirSync(out, { withFileTypes: true })) {
    if (!target.isDirectory() || target.name.startsWith(".") || target.name === "targets") continue;
    for (const mode of readdirSync(join(out, target.name), { withFileTypes: true })) {
      if (!mode.isDirectory()) continue;
      for (const sample of readdirSync(join(out, target.name, mode.name))) {
        const dir = join(out, target.name, mode.name, sample);
        if (existsSync(join(dir, "meta.json"))) dirs.push(dir);
      }
    }
  }
  return dirs.sort();
}

async function pixels(path: string, width: number, height: number, format: "gray" | "rgb"): Promise<Uint8Array> {
  const color = format === "gray" ? ["-colorspace", "Gray"] : ["-colorspace", "sRGB"];
  const out = await run(["magick", path, "-resize", `${width}x${height}!`, ...color, "-depth", "8", `${format}:-`]);
  if (out.code !== 0) throw new Error(`magick failed on ${path}: ${out.stderr}`);
  return out.stdout;
}

async function pixelScores(targetPng: string, buildPng: string, target: Target) {
  const width = COMPARE_WIDTH;
  const height = Math.round((COMPARE_WIDTH * target.height) / target.width);
  const [ga, gb, ca, cb] = await Promise.all([
    pixels(targetPng, width, height, "gray"), pixels(buildPng, width, height, "gray"),
    pixels(targetPng, width, height, "rgb"), pixels(buildPng, width, height, "rgb"),
  ]);
  return { ssim: ssimFromPixels(ga, gb, width, height), histogram_distance: histogramDistance(colorHistogram(ca), colorHistogram(cb)) };
}

export async function inTempDir<T>(files: Record<string, string>, work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "bench-judge-"));
  for (const [name, from] of Object.entries(files)) copyFileSync(from, join(dir, name));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type Verdict<T> = { value?: T; cost: number; error?: string };

export async function askTwice<T>(dir: string, prompt: string, model: string, parse: (text: string) => T): Promise<Verdict<T>> {
  let cost = 0;
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runClaude({ prompt, cwd: dir, model, tools: ["Read"], allowed: ["Read"], timeoutMs: 6 * 60_000, budgetUsd: 2 });
    cost += result.cost_usd ?? 0;
    try {
      return { value: parse(result.text), cost };
    } catch (e) {
      error = `${(e as Error).message}; claude: ${result.error ?? result.text.slice(0, 200)}`;
    }
  }
  return { cost, error };
}

function judge(targetImage: string, buildPng: string, model: string): Promise<Verdict<Judgement>> {
  return inTempDir({ "1-target.jpg": targetImage, "2-build.png": buildPng }, dir => askTwice(dir, JUDGE_PROMPT, model, parseJudgement));
}

function judgeRules(buildDir: string, rules: string[], model: string): Promise<Verdict<RuleSummary>> {
  const html = prepareHtml(readFileSync(join(buildDir, "index.html"), "utf8"));
  const prompt = ruleJudgePrompt(rules, html);
  return inTempDir({ "2-build.png": join(buildDir, "build.png") }, dir => askTwice(dir, prompt, model, text => parseRuleJudgement(text, rules)));
}

export async function loadRules(out: string): Promise<string[]> {
  const path = join(out, "rules.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const proc = Bun.spawn([join(TASTE_SKILL, "scripts/taste"), "profile"], { env: { ...process.env, DESIGN_MEMORY_HOME: join(out, ".taste-home") }, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`taste profile failed for ${out}`);
  const rules = parseProfileRules(text);
  if (!rules.length) throw new Error(`no rules in the taste profile for ${out}`);
  writeFileSync(path, JSON.stringify(rules, null, 2));
  return rules;
}

export function currentScore(score: BuildScore | null): boolean {
  return !!score && score.judge_scale === JUDGE_SCALE && (score.rules !== undefined || !score.ok);
}

function cached(path: string, options: ScoreOptions): BuildScore | null {
  if (options.force) return null;
  const score = readJson<BuildScore>(path);
  return currentScore(score) ? score : null;
}

type ScoreCtx = { out: string; targets: Map<string, Target>; options: ScoreOptions; rules: string[] };

async function judgedScore(dir: string, target: Target, base: Pick<BuildScore, "target" | "mode" | "sample">, ctx: ScoreCtx): Promise<BuildScore> {
  const targetImage = join(ctx.out, "targets", `${target.id}.jpg`);
  const buildPng = join(dir, "build.png");
  const model = ctx.options.judgeModel;
  const [px, verdict, rules] = await Promise.all([pixelScores(targetImage, buildPng, target), judge(targetImage, buildPng, model), judgeRules(dir, ctx.rules, model)]);
  const error = [verdict.error, rules.error].filter(Boolean).join("; ") || undefined;
  return {
    ...base, ok: !!verdict.value, ...px, judge: verdict.value, judge_cost_usd: round(verdict.cost), judge_scale: JUDGE_SCALE,
    rules: rules.value, rules_cost_usd: round(rules.cost), objective: buildObjective(true, verdict.value, rules.value), error, judge_model: model,
  } as BuildScore;
}

async function scoreBuild(dir: string, ctx: ScoreCtx): Promise<BuildScore> {
  const path = join(dir, "score.json");
  const hit = cached(path, ctx.options);
  if (hit) return hit;
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const base = { target: meta.target, mode: meta.mode, sample: meta.sample };
  const target = ctx.targets.get(meta.target);
  const score: BuildScore = !meta.ok || !target
    ? { ...base, ok: false, error: meta.error ?? "unknown target", judge_scale: JUDGE_SCALE, objective: buildObjective(false, undefined, undefined) }
    : await judgedScore(dir, target, base, ctx);
  writeFileSync(path, JSON.stringify(score, null, 2));
  return score;
}

export type ScoreResult = { scores: BuildScore[]; judge_cost_usd: number };

export async function scoreRun(options: ScoreOptions, quiet = false): Promise<ScoreResult> {
  const out = resolve(options.run);
  const ctx: ScoreCtx = { out, targets: new Map(loadTargets().map(t => [t.id, t])), options, rules: await loadRules(out) };
  const dirs = buildDirs(out);
  let done = 0;
  const scores = await pool(dirs, options.concurrency, async dir => {
    const s = await scoreBuild(dir, ctx);
    if (!quiet) console.log(`[${++done}/${dirs.length}] ${s.target} ${s.mode} #${s.sample} ${s.ok ? `overall ${s.judge?.overall.score}/10 rules ${s.rules?.rule_pass ?? "–"} objective ${s.objective}` : `FAILED ${s.error}`}`);
    return s;
  });
  const metas: BuildMeta[] = dirs.map(d => JSON.parse(readFileSync(join(d, "meta.json"), "utf8")));
  const runInfo = existsSync(join(out, "run.json")) ? JSON.parse(readFileSync(join(out, "run.json"), "utf8")) : {};
  const judgeCost = round(scores.reduce((a, s) => a + (s.judge_cost_usd ?? 0) + (s.rules_cost_usd ?? 0), 0));
  const summary = { run: out, wall_ms: runInfo.wall_ms, build_cost_usd: round(runInfo.cost_usd ?? 0), judge_cost_usd: judgeCost, judge_model: options.judgeModel, judge_scale: JUDGE_SCALE, rules: ctx.rules, ...summarize(scores, metas) };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  if (!quiet) console.log(`wrote ${join(out, "summary.json")}. Next: bun bench/report.ts --run ${out}`);
  return { scores, judge_cost_usd: judgeCost };
}

async function main() {
  await scoreRun(parseScoreArgs(process.argv.slice(2)));
}

if (import.meta.main) await main();
