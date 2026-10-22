import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { round } from "./lib.ts";
import type { Target } from "./lib.ts";
import { autoVote, leftArm, outcomes, pairCalls, pairFile, pairPrompt, parsePairVerdict, QUESTIONS, summarizePairs } from "./pairwise.ts";
import type { Arm, CallResult, PairCall, PairOutcome, PairSummary } from "./pairwise.ts";
import { readJson } from "./resume.ts";
import { pool } from "./run.ts";
import { askTwice, inTempDir } from "./score.ts";

export type ArmRef = { out: string; mode: string };
export type PairJob = { dir: string; a: ArmRef; b: ArmRef; targets: Target[]; samples: number; rules: string[]; model: string; concurrency: number };
export type PairResult = { outcomes: PairOutcome[]; summary: PairSummary; results: CallResult[]; cost: number; calls: number };

function buildOk(arm: ArmRef, target: string, sample: number): boolean {
  const dir = join(arm.out, target, arm.mode, String(sample));
  const meta = readJson<{ ok?: boolean }>(join(dir, "meta.json"));
  return !!meta?.ok && existsSync(join(dir, "build.png"));
}

function pngOf(arm: ArmRef, call: PairCall): string {
  return join(arm.out, call.target, arm.mode, String(call.sample), "build.png");
}

async function judgeCall(job: PairJob, call: PairCall): Promise<CallResult> {
  const left: Arm = leftArm(call.order);
  const [l, r] = left === "a" ? [job.a, job.b] : [job.b, job.a];
  const files = { "1-target.jpg": join(job.a.out, "targets", `${call.target}.jpg`), "2-left.png": pngOf(l, call), "3-right.png": pngOf(r, call) };
  const v = await inTempDir(files, dir => askTwice(dir, pairPrompt(job.rules), job.model, parsePairVerdict));
  return { ...call, verdict: v.value, cost: round(v.cost), error: v.error };
}

async function oneCall(job: PairJob, call: PairCall): Promise<CallResult> {
  const path = join(job.dir, pairFile(call));
  const saved = readJson<CallResult>(path);
  if (saved && (saved.auto || (saved.verdict && QUESTIONS.every(q => saved.verdict![q])))) return saved;
  const mode = autoVote(buildOk(job.a, call.target, call.sample), buildOk(job.b, call.target, call.sample));
  if (mode === null) return { ...call, cost: 0, error: "both builds failed" };
  const result = mode === "judge" ? await judgeCall(job, call) : { ...call, auto: mode, cost: 0 };
  writeFileSync(path, JSON.stringify({ ...result, left: leftArm(call.order) }, null, 2));
  return result;
}

export async function judgePairs(job: PairJob): Promise<PairResult> {
  mkdirSync(job.dir, { recursive: true });
  const keys = job.targets.flatMap(t => Array.from({ length: job.samples }, (_, i) => ({ target: t.id, sample: i + 1 })));
  const results = await pool(pairCalls(keys), job.concurrency, call => oneCall(job, call));
  const list = outcomes(results.filter(r => r.verdict || r.auto));
  const summary = summarizePairs(list, results.filter(r => r.error !== "both builds failed"));
  const calls = results.filter(r => r.verdict || (r.error && r.error !== "both builds failed")).length;
  return { outcomes: list, summary, results, cost: round(results.reduce((a, r) => a + r.cost, 0)), calls };
}
