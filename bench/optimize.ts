import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFlags, round, selectTargets, timestamp } from "./lib.ts";
import type { BuildScore, Mode, Target } from "./lib.ts";
import { armSummary, lintCandidate, splitTargets } from "./objective.ts";
import type { ArmScore } from "./objective.ts";
import { focusById, FOCUSES, proposerPrompt, writeFeedback } from "./optimize-feedback.ts";
import type { Attempt, CaseLabel, Focus } from "./optimize-feedback.ts";
import { contactSheet, writeOptimizeReport } from "./optimize-report.ts";
import { judgePairs } from "./pair-judge.ts";
import type { ArmRef, PairResult } from "./pair-judge.ts";
import { addTotals, decide, EMPTY_TOTALS, focusOrder, holdoutEstimate, pickBest, planRound, QUESTIONS, unitCosts } from "./pairwise.ts";
import type { AcceptRule, CostTotals, Decision, PairOutcome, PairSummary, Question } from "./pairwise.ts";
import { BENCH, loadTargets, runBench } from "./run.ts";
import { attemptsFrom, readJson, restoreRounds, savedProposal } from "./resume.ts";
import type { CandidateRecord, RoundRecord } from "./resume.ts";
import { loadRules, scoreRun } from "./score.ts";
import { parseClaudeOutput, run, runClaude, SKILL_FILES } from "./tools.ts";

const REPO = dirname(BENCH);
const MAX_SKILL_LINES = 95;
const EXTRA_BANNED = ["Stripe", "Escalation Watch", "Payvora"];

export type OptimizeOptions = {
  rounds: number; samples: number; budgetUsd: number; holdoutSamples: number; candidates: number;
  trainTargets: string[] | null; holdoutTargets: string[] | null;
  model: string; judgeModel: string; proposerModel: string; concurrency: number; buildBudgetUsd: number; out: string | null;
  accept: AcceptRule; seedFrom: string | null; extraArms?: { name: string; dir: string }[]; seedFocus: { round: number; focus: string } | null; changes?: { round: number; note: string }[];
};

function num(flags: Map<string, string>, key: string, fallback: number): number {
  const v = flags.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive number`);
  return n;
}

const FLAGS = new Set([
  "rounds", "samples", "budget-usd", "holdout-samples", "candidates", "train-targets", "holdout-targets", "model", "judge-model", "proposer-model",
  "concurrency", "build-budget-usd", "out", "accept-on", "min-win-rate", "max-p", "min-guard-rate", "guard-loss-p", "seed-from", "guards", "seed-focus",
]);

function acceptRule(flags: Map<string, string>): AcceptRule {
  const on = flags.get("accept-on") ?? "closer";
  if (!(QUESTIONS as readonly string[]).includes(on)) throw new Error(`--accept-on must be ${QUESTIONS.join(" or ")}`);
  return { on: on as Question, minWinRate: num(flags, "min-win-rate", 0.6), maxP: num(flags, "max-p", 0.2), minGuardRate: num(flags, "min-guard-rate", 0.4), guardLossP: num(flags, "guard-loss-p", 0.2), guards: guardList(flags.get("guards"), on as Question) };
}

function guardList(value: string | undefined, on: Question): Question[] {
  const list = value ? value.split(",").map(x => x.trim()).filter(Boolean) : QUESTIONS.filter(q => q !== on);
  const bad = list.filter(q => !(QUESTIONS as readonly string[]).includes(q) || q === on);
  if (bad.length) throw new Error(`--guards must name questions other than --accept-on: ${bad.join(", ")}`);
  return list as Question[];
}

function seedFocusFlag(value: string | undefined): { round: number; focus: string } | null {
  if (!value) return null;
  focusById(value);
  return { round: 1, focus: value };
}

export function roundFocuses(o: Pick<OptimizeOptions, "seedFocus">, k: number, count: number): Focus[] {
  if (o.seedFocus?.round !== k) return focusOrder(FOCUSES, k, count);
  return [focusById(o.seedFocus.focus), ...focusOrder(FOCUSES, k, count - 1)];
}

export function parseOptimizeArgs(argv: string[]): OptimizeOptions {
  const flags = readFlags(argv);
  const unknown = [...flags.keys()].filter(k => !FLAGS.has(k));
  if (unknown.length) throw new Error(`unknown flag: --${unknown.join(", --")}`);
  const ids = (key: string) => flags.get(key)?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
  const candidates = Math.round(num(flags, "candidates", 3));
  if (candidates > FOCUSES.length) throw new Error(`--candidates is at most ${FOCUSES.length}`);
  return {
    rounds: Math.round(num(flags, "rounds", 5)), samples: Math.round(num(flags, "samples", 2)), budgetUsd: num(flags, "budget-usd", 60),
    holdoutSamples: Math.round(num(flags, "holdout-samples", 3)), candidates,
    trainTargets: ids("train-targets"), holdoutTargets: ids("holdout-targets"),
    model: flags.get("model") ?? "sonnet", judgeModel: flags.get("judge-model") ?? "opus", proposerModel: flags.get("proposer-model") ?? "opus",
    concurrency: Math.round(num(flags, "concurrency", 6)), buildBudgetUsd: num(flags, "build-budget-usd", 5), out: flags.get("out") ?? null,
    accept: acceptRule(flags), seedFrom: flags.get("seed-from") ?? null, seedFocus: seedFocusFlag(flags.get("seed-focus")),
  };
}

type Eval = { name: string; out: string; scores: BuildScore[]; byMode: Record<string, BuildScore[]>; cost: number };
type Ctx = { opt: string; options: OptimizeOptions; train: Target[]; holdout: Target[]; spent: number; totals: CostTotals; resume: boolean };
type EvalSpec = { name: string; skillDir: string; targets: Target[]; modes: Mode[]; samples: number; score: boolean; concurrency?: number };

function log(line: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}

function charge(ctx: Ctx, usd: number, totals: Partial<CostTotals>) {
  ctx.spent = round(ctx.spent + usd);
  ctx.totals = addTotals(ctx.totals, totals);
}

async function evaluate(ctx: Ctx, spec: EvalSpec): Promise<Eval> {
  const out = join(ctx.opt, "evals", spec.name);
  const o = ctx.options;
  const concurrency = spec.concurrency ?? o.concurrency;
  const runInfo = await runBench({ targets: spec.targets.map(t => t.id), modes: spec.modes, samples: spec.samples, model: o.model, concurrency, out, timeoutMinutes: 20, budgetUsd: o.buildBudgetUsd, skillDir: spec.skillDir }, spec.targets, true, ctx.resume);
  const scored = spec.score ? await scoreRun({ run: out, judgeModel: o.judgeModel, concurrency, force: false }, true) : { scores: [], judge_cost_usd: 0 };
  const byMode: Record<string, BuildScore[]> = {};
  for (const s of scored.scores) byMode[s.mode] = [...(byMode[s.mode] ?? []), s];
  const cost = round(runInfo.cost_usd + scored.judge_cost_usd);
  charge(ctx, cost, { build_usd: runInfo.cost_usd, builds: runInfo.builds, score_usd: scored.judge_cost_usd, scored: scored.scores.filter(s => s.judge).length });
  log(`eval ${spec.name}: ${runInfo.builds} builds, ${runInfo.failed} failed, $${cost.toFixed(2)} (total $${ctx.spent.toFixed(2)})`);
  return { name: spec.name, out, scores: scored.scores, byMode, cost };
}

function readSkill(dir: string): Record<string, string> {
  return Object.fromEntries(SKILL_FILES.map(f => [f, readFileSync(join(dir, f), "utf8")]));
}

function copySkill(from: string, to: string) {
  for (const f of SKILL_FILES) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(from, f), join(to, f));
  }
}

function originalSkill(opt: string): string {
  const dir = join(opt, "original");
  mkdirSync(join(dir, "references"), { recursive: true });
  cpSync(join(REPO, "skills/taste-use/SKILL.md"), join(dir, "SKILL.md"));
  for (const f of SKILL_FILES.filter(f => f.startsWith("references/"))) cpSync(join(REPO, f), join(dir, f));
  return dir;
}

export async function skillDiff(a: string, b: string): Promise<string> {
  const out = await run(["git", "diff", "--no-index", "--no-color", "--no-prefix", "--", a, b]);
  return new TextDecoder().decode(out.stdout).replaceAll(`${a.slice(1)}/`, "before/").replaceAll(`${b.slice(1)}/`, "after/");
}

type Proposal = { focus: Focus; dir: string; summary: string; cost: number; error?: string };
type RoundInput = { k: number; incDir: string; inc: Eval; labels: CaseLabel; attempts: Attempt[] };

function savedCandidate(candDir: string): Omit<Proposal, "focus" | "dir"> | null {
  const dir = join(candDir, "candidate");
  const path = join(candDir, "proposer-transcript.json");
  const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  return savedProposal(SKILL_FILES.map(f => existsSync(join(dir, f))), raw === null ? null : parseClaudeOutput(raw));
}

async function freshProposal(ctx: Ctx, focus: Focus, candDir: string, input: RoundInput): Promise<Omit<Proposal, "focus" | "dir">> {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "bench-proposer-")));
  try {
    copySkill(input.incDir, join(ws, "skill"));
    await writeFeedback(join(ws, "feedback"), { out: input.inc.out, scores: input.inc.byMode.taste ?? [] }, input.labels, input.attempts);
    cpSync(join(ws, "feedback"), join(candDir, "feedback"), { recursive: true });
    const result = await runClaude({
      prompt: proposerPrompt(focus), cwd: ws, model: ctx.options.proposerModel, tools: ["Read", "Edit", "Write"],
      allowed: [`Read(/${ws}/**)`, `Edit(/${ws}/skill/**)`, `Write(/${ws}/skill/**)`], timeoutMs: 20 * 60_000, budgetUsd: 4,
    });
    writeFileSync(join(candDir, "proposer-transcript.json"), result.raw);
    copySkill(join(ws, "skill"), join(candDir, "candidate"));
    return { summary: result.text.trim(), cost: round(result.cost_usd ?? 0), error: result.ok ? undefined : result.error };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

async function propose(ctx: Ctx, focus: Focus, input: RoundInput): Promise<Proposal> {
  const candDir = join(ctx.opt, `round-${input.k}`, `cand-${focus.id}`);
  mkdirSync(candDir, { recursive: true });
  const saved = savedCandidate(candDir);
  if (saved) log(`round ${input.k} ${focus.id}: reusing saved proposal`);
  const p = saved ?? await freshProposal(ctx, focus, candDir, input);
  charge(ctx, p.cost, { proposer_usd: p.cost, proposers: 1 });
  return { focus, dir: join(candDir, "candidate"), ...p };
}

function bannedWords(targets: Target[]): string[] {
  return [...targets.flatMap(t => [t.id, t.author, `@${t.author}`]), ...EXTRA_BANNED];
}

function precheck(p: Proposal, incumbentDir: string, banned: string[]): string[] {
  if (p.error) return [`proposer failed: ${p.error}`];
  const files = readSkill(p.dir);
  const inc = readSkill(incumbentDir);
  if (SKILL_FILES.every(f => files[f] === inc[f])) return ["the proposer made no edits"];
  const { "SKILL.md": skill, ...refs } = files;
  return lintCandidate({ skill: skill!, files: refs, banned, maxSkillLines: MAX_SKILL_LINES });
}

export function lossReasons(list: PairOutcome[], loser: "a" | "b" = "b"): string[] {
  const winner = loser === "a" ? "b" : "a";
  return list.flatMap(o => QUESTIONS.flatMap(q => o.reasons[q].filter(r => r.winner === winner).map(r => `${q}: ${r.reason}`)));
}

type Trial = { rec: CandidateRecord; decision: Decision; summary: PairSummary | null };
type Judged = Trial & { summary: PairSummary };

function rejected(p: Proposal, diff: string, lint: string[]): Trial {
  const reason = `rejected before eval: ${lint.join("; ")}`;
  return { rec: { focus: p.focus.id, dir: p.dir, diff, lint, summary: p.summary, eval_dir: null, pairs: null, accepted: false, reason, losses: [], cost: { proposer: p.cost, builds: 0, pairs: 0, total: p.cost } }, decision: { accept: false, reason }, summary: null };
}

async function pairUp(ctx: Ctx, dir: string, a: ArmRef, b: ArmRef, targets: Target[], samples: number, rules: string[], concurrency: number): Promise<PairResult> {
  const pr = await judgePairs({ dir, a, b, targets, samples, rules, model: ctx.options.judgeModel, concurrency });
  charge(ctx, pr.cost, { pair_usd: pr.cost, pairs: pr.calls });
  return pr;
}

async function trial(ctx: Ctx, p: Proposal, input: RoundInput, rules: string[], concurrency: number): Promise<Trial> {
  const diff = await skillDiff(input.incDir, p.dir);
  const lint = precheck(p, input.incDir, bannedWords([...ctx.train, ...ctx.holdout]));
  if (lint.length) return rejected(p, diff, lint);
  const o = ctx.options;
  const e = await evaluate(ctx, { name: `round-${input.k}-cand-${p.focus.id}`, skillDir: p.dir, targets: ctx.train, modes: ["taste"], samples: o.samples, score: false, concurrency });
  const pr = await pairUp(ctx, join(ctx.opt, `round-${input.k}`, `cand-${p.focus.id}`, "pairs"), { out: input.inc.out, mode: "taste" }, { out: e.out, mode: "taste" }, ctx.train, o.samples, rules, concurrency);
  const decision = decide(pr.summary, o.accept);
  const cost = { proposer: p.cost, builds: e.cost, pairs: pr.cost, total: round(p.cost + e.cost + pr.cost) };
  const rec: CandidateRecord = { focus: p.focus.id, dir: p.dir, diff, lint, summary: p.summary, eval_dir: e.out, pairs: pr.summary, accepted: decision.accept, reason: decision.reason, losses: lossReasons(pr.outcomes), cost };
  log(`round ${input.k} ${p.focus.id}: ${decision.accept ? "passes" : "fails"}. ${decision.reason}`);
  return { rec, decision, summary: pr.summary };
}

type LoopState = { incDir: string; incFrom: number; history: RoundRecord[]; attempts: Attempt[]; nextRound: number };

function writeHistory(opt: string, history: RoundRecord[]) {
  writeFileSync(join(opt, "history.json"), JSON.stringify(history, null, 2));
}

async function oneRound(ctx: Ctx, k: number, st: LoopState, labels: CaseLabel, count: number): Promise<void> {
  const before = ctx.spent;
  const o = ctx.options;
  log(`round ${k}: ${count} candidates; fresh incumbent builds (skill from round ${st.incFrom})`);
  const inc = await evaluate(ctx, { name: `round-${k}-incumbent`, skillDir: st.incDir, targets: ctx.train, modes: ["taste"], samples: o.samples, score: true });
  const rules = await loadRules(inc.out);
  const input: RoundInput = { k, incDir: st.incDir, inc, labels, attempts: st.attempts };
  const proposals = await Promise.all(roundFocuses(o, k, count).map(f => propose(ctx, f, input)));
  const concurrency = Math.max(1, Math.ceil(o.concurrency / proposals.length));
  const trials = await Promise.all(proposals.map(p => trial(ctx, p, input, rules, concurrency)));
  const best = pickBest(trials.filter((t): t is Judged => t.summary !== null), o.accept.on);
  const record: RoundRecord = {
    round: k, questions: [...QUESTIONS], change: o.changes?.find(c => c.round === k)?.note, incumbent_dir: st.incDir, incumbent_from: st.incFrom, incumbent_eval: inc.out, incumbent_score: armSummary(inc.byMode.taste ?? []),
    candidates: trials.map(t => t.rec), promoted: best?.rec.focus ?? null, cost: round(ctx.spent - before), spent_after: ctx.spent, totals: ctx.totals,
  };
  st.history.push(record);
  st.attempts.push(...trials.map(t => ({ round: k, focus: t.rec.focus, accepted: t.rec.focus === record.promoted, reason: t.rec.reason, summary: t.rec.summary, diff: t.rec.diff, losses: t.rec.losses })));
  if (best) Object.assign(st, { incDir: best.rec.dir, incFrom: k });
  writeHistory(ctx.opt, st.history);
  log(`round ${k}: ${best ? `PROMOTED ${best.rec.focus}` : "no candidate promoted"}. Round cost $${record.cost.toFixed(2)}, total $${ctx.spent.toFixed(2)}`);
}

function nextPlan(ctx: Ctx, k: number) {
  const o = ctx.options;
  const units = unitCosts(ctx.totals);
  const reserve = holdoutEstimate(units, ctx.holdout.length * o.holdoutSamples, true);
  return planRound({ round: k, rounds: o.rounds, spent: ctx.spent, units, builds: ctx.train.length * o.samples, maxCandidates: o.candidates, reserve, budget: o.budgetUsd });
}

async function runLoop(ctx: Ctx, st: LoopState, labels: CaseLabel): Promise<string> {
  for (let k = st.nextRound; ; k++) {
    const plan = nextPlan(ctx, k);
    if (plan.stop) return plan.stop;
    await oneRound(ctx, k, st, labels, plan.candidates);
  }
}

type Holdout = { arms: Record<string, ArmScore>; pairs: Record<string, PairSummary>; runs: Record<string, string> };
export type Arm = { name: string; ref: ArmRef; scores: BuildScore[] };

function extraDir(opt: string, dir: string): string {
  return dir.startsWith("/") ? dir : join(opt, dir);
}

async function extraArms(ctx: Ctx, hs: number): Promise<Arm[]> {
  const out: Arm[] = [];
  for (const x of ctx.options.extraArms ?? []) {
    const e = await evaluate(ctx, { name: `holdout-${x.name}`, skillDir: extraDir(ctx.opt, x.dir), targets: ctx.holdout, modes: ["taste"], samples: hs, score: true });
    out.push({ name: x.name, ref: { out: e.out, mode: "taste" }, scores: e.byMode.taste ?? [] });
  }
  return out;
}

export function comparisons(arms: Arm[], extras: Arm[], bestDiffers: boolean): [string, Arm, Arm][] {
  const [baseline, original, best] = arms as [Arm, Arm, Arm];
  const list: [string, Arm, Arm][] = [["best_vs_baseline", baseline, best]];
  if (bestDiffers) list.push(["best_vs_original", original, best]);
  for (const x of extras) {
    list.push([`${x.name}_vs_original`, original, x], [`${x.name}_vs_baseline`, baseline, x]);
    if (bestDiffers) list.push([`${x.name}_vs_best`, best, x]);
  }
  return list;
}

async function holdoutEvals(ctx: Ctx, original: string, st: LoopState): Promise<Holdout> {
  const hs = ctx.options.holdoutSamples;
  const base = await evaluate(ctx, { name: "holdout-original", skillDir: original, targets: ctx.holdout, modes: ["baseline", "taste"], samples: hs, score: true });
  const best = st.incFrom > 0 ? await evaluate(ctx, { name: "holdout-best", skillDir: st.incDir, targets: ctx.holdout, modes: ["taste"], samples: hs, score: true }) : base;
  const arms: Arm[] = [
    { name: "baseline", ref: { out: base.out, mode: "baseline" }, scores: base.byMode.baseline ?? [] },
    { name: "original", ref: { out: base.out, mode: "taste" }, scores: base.byMode.taste ?? [] },
    { name: "best", ref: { out: best.out, mode: "taste" }, scores: best.byMode.taste ?? [] },
  ];
  const extras = await extraArms(ctx, hs);
  const rules = await loadRules(base.out);
  const pairs: Record<string, PairSummary> = {};
  for (const [name, a, b] of comparisons(arms, extras, st.incFrom > 0)) {
    pairs[name] = (await pairUp(ctx, join(ctx.opt, "holdout-pairs", name.replaceAll("_", "-")), a.ref, b.ref, ctx.holdout, hs, rules, ctx.options.concurrency)).summary;
  }
  const all = [...arms, ...extras];
  return { arms: Object.fromEntries(all.map(a => [a.name, armSummary(a.scores)])), pairs, runs: Object.fromEntries(all.filter(a => a.name !== "baseline").map(a => [a.name, a.ref.out])) };
}

async function finish(ctx: Ctx, st: LoopState, original: string, stop: string) {
  log(`stop: ${stop}. Best skill is from round ${st.incFrom}. Running holdout.`);
  const h = await holdoutEvals(ctx, original, st);
  const final = {
    stop_reason: stop, best_round: st.incFrom, best_dir: st.incDir, original_dir: original, accept_rule: ctx.options.accept, changes: ctx.options.changes ?? [],
    holdout_targets: ctx.holdout.map(t => t.id), holdout_samples: ctx.options.holdoutSamples,
    holdout: h.arms, holdout_pairs: h.pairs, holdout_runs: h.runs, total_cost_usd: ctx.spent, cost_totals: ctx.totals,
  };
  writeFileSync(join(ctx.opt, "final.json"), JSON.stringify(final, null, 2));
  await writeOptimizeReport(ctx.opt, final, st.history, await skillDiff(original, st.incDir), await contactSheet(ctx.opt, final));
  log(`done. total $${ctx.spent.toFixed(2)}. ${join(ctx.opt, "report.html")}`);
}

function resolveTargets(all: Target[], split: "train" | "holdout", ids: string[] | null): Target[] {
  const pool = splitTargets(all, split);
  if (!ids) return pool;
  const bad = ids.filter(id => !pool.some(t => t.id === id));
  if (bad.length) throw new Error(`not ${split} targets: ${bad.join(", ")}`);
  return selectTargets(pool, ids);
}

function pickTargets(all: Target[], ids: string[]): Target[] {
  return ids.map(id => {
    const t = all.find(x => x.id === id);
    if (!t) throw new Error(`unknown target in options.json: ${id}`);
    return t;
  });
}

type Setup = { ctx: Ctx; st: LoopState; original: string; labels: CaseLabel };

function labelsFor(train: Target[]): CaseLabel {
  return new Map(train.map((t, i) => [t.id, `case-${i + 1}`]));
}

const SEED_FILE = "seed-attempts.json";

function seedAttempts(opt: string, from: string | null): Attempt[] {
  if (!from) return [];
  const history = readJson<RoundRecord[]>(join(resolve(from), "history.json"));
  if (!history) throw new Error(`--seed-from ${from} has no history.json`);
  const label = from.replace(/\/+$/, "").split("/").at(-1) ?? "seed";
  const seeds = attemptsFrom(history).map(a => ({ ...a, accepted: false, source: `earlier run ${label},` }));
  writeFileSync(join(opt, SEED_FILE), JSON.stringify(seeds, null, 2));
  return seeds;
}

function freshSetup(options: OptimizeOptions): Setup {
  const all = loadTargets();
  const opt = resolve(options.out ?? join(BENCH, "optimize", timestamp()));
  if (existsSync(join(opt, "history.json"))) throw new Error(`${opt} already has a run; use --resume ${opt}`);
  mkdirSync(opt, { recursive: true });
  const ctx: Ctx = { opt, options, train: resolveTargets(all, "train", options.trainTargets), holdout: resolveTargets(all, "holdout", options.holdoutTargets), spent: 0, totals: EMPTY_TOTALS, resume: false };
  writeFileSync(join(opt, "options.json"), JSON.stringify({ ...options, train: ctx.train.map(t => t.id), holdout: ctx.holdout.map(t => t.id) }, null, 2));
  const original = originalSkill(opt);
  writeHistory(opt, []);
  const seeds = seedAttempts(opt, options.seedFrom);
  log(`optimize ${opt}: train ${ctx.train.length} x ${options.samples}, ${options.candidates} candidates/round, holdout ${ctx.holdout.length} x ${options.holdoutSamples}, budget $${options.budgetUsd}`);
  return { ctx, original, labels: labelsFor(ctx.train), st: { incDir: original, incFrom: 0, history: [], attempts: seeds, nextRound: 1 } };
}

function resumeSetup(dir: string): Setup {
  const opt = resolve(dir);
  const stored = readJson<OptimizeOptions & { train: string[]; holdout: string[] }>(join(opt, "options.json"));
  const history = readJson<RoundRecord[]>(join(opt, "history.json"));
  if (!stored || !history) throw new Error(`${opt} needs options.json and history.json`);
  const all = loadTargets();
  const original = join(opt, "original");
  const r = restoreRounds(history, original);
  const ctx: Ctx = { opt, options: stored, train: pickTargets(all, stored.train), holdout: pickTargets(all, stored.holdout), spent: r.spent, totals: r.totals, resume: true };
  for (const c of stored.changes ?? []) if (c.round >= r.nextRound) log(`change from round ${c.round}: ${c.note}`);
  log(`resume ${opt}: ${history.length} rounds done, incumbent from round ${r.incumbentFrom}, spent $${ctx.spent.toFixed(2)}`);
  return { ctx, original, labels: labelsFor(ctx.train), st: { incDir: r.incumbentDir, incFrom: r.incumbentFrom, history, attempts: [...(readJson<Attempt[]>(join(opt, SEED_FILE)) ?? []), ...r.attempts], nextRound: r.nextRound } };
}

export function resumeArg(argv: string[]): string | null {
  const flags = readFlags(argv);
  const dir = flags.get("resume");
  if (dir === undefined) return null;
  if (dir === "true") throw new Error("--resume needs a folder");
  if (flags.size > 1) throw new Error("--resume takes no other flags; it uses the folder's options.json");
  return dir;
}

async function main() {
  const argv = process.argv.slice(2);
  const dir = resumeArg(argv);
  const { ctx, st, original, labels } = dir ? resumeSetup(dir) : freshSetup(parseOptimizeArgs(argv));
  await finish(ctx, st, original, await runLoop(ctx, st, labels));
}

if (import.meta.main) await main();
