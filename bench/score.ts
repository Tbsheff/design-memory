import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { colorHistogram, histogramDistance, JUDGE_PROMPT, parseJudgement, parseScoreArgs, round, ssimFromPixels, summarize } from "./lib.ts";
import type { BuildMeta, BuildScore, Judgement, ScoreOptions, Target } from "./lib.ts";
import { loadTargets, pool } from "./run.ts";
import { run, runClaude } from "./tools.ts";

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

async function judge(targetImage: string, buildPng: string, model: string): Promise<{ judge?: Judgement; cost: number; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "bench-judge-"));
  copyFileSync(targetImage, join(dir, "1-target.jpg"));
  copyFileSync(buildPng, join(dir, "2-build.png"));
  let cost = 0;
  let error = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runClaude({ prompt: JUDGE_PROMPT, cwd: dir, model, tools: ["Read"], allowed: ["Read"], timeoutMs: 6 * 60_000, budgetUsd: 2 });
      cost += result.cost_usd ?? 0;
      try {
        return { judge: parseJudgement(result.text), cost };
      } catch (e) {
        error = `${(e as Error).message}; claude: ${result.error ?? result.text.slice(0, 200)}`;
      }
    }
    return { cost, error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function scoreBuild(dir: string, out: string, targets: Map<string, Target>, options: ScoreOptions): Promise<BuildScore> {
  const path = join(dir, "score.json");
  if (existsSync(path) && !options.force) return JSON.parse(readFileSync(path, "utf8"));
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const base = { target: meta.target, mode: meta.mode, sample: meta.sample };
  const target = targets.get(meta.target);
  let score: BuildScore;
  if (!meta.ok || !target) score = { ...base, ok: false, error: meta.error ?? "unknown target" };
  else {
    const targetImage = join(out, "targets", `${target.id}.jpg`);
    const buildPng = join(dir, "build.png");
    const [px, verdict] = await Promise.all([pixelScores(targetImage, buildPng, target), judge(targetImage, buildPng, options.judgeModel)]);
    score = { ...base, ok: !!verdict.judge, ...px, judge: verdict.judge, judge_cost_usd: round(verdict.cost), error: verdict.error, judge_model: options.judgeModel } as BuildScore;
  }
  writeFileSync(path, JSON.stringify(score, null, 2));
  return score;
}

async function main() {
  const options = parseScoreArgs(process.argv.slice(2));
  const out = resolve(options.run);
  const targets = new Map(loadTargets().map(t => [t.id, t]));
  const dirs = buildDirs(out);
  let done = 0;
  const scores = await pool(dirs, options.concurrency, async dir => {
    const s = await scoreBuild(dir, out, targets, options);
    console.log(`[${++done}/${dirs.length}] ${s.target} ${s.mode} #${s.sample} ${s.ok ? `overall ${s.judge?.overall.score} ssim ${s.ssim}` : `FAILED ${s.error}`}`);
    return s;
  });
  const metas: BuildMeta[] = dirs.map(d => JSON.parse(readFileSync(join(d, "meta.json"), "utf8")));
  const runInfo = existsSync(join(out, "run.json")) ? JSON.parse(readFileSync(join(out, "run.json"), "utf8")) : {};
  const judgeCost = round(scores.reduce((a, s) => a + (s.judge_cost_usd ?? 0), 0));
  const summary = { run: out, wall_ms: runInfo.wall_ms, build_cost_usd: round(runInfo.cost_usd ?? 0), judge_cost_usd: judgeCost, judge_model: options.judgeModel, ...summarize(scores, metas) };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`wrote ${join(out, "summary.json")}. Next: bun bench/report.ts --run ${out}`);
}

if (import.meta.main) await main();
