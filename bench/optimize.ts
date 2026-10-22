import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DIMENSIONS, readFlags, round, selectTargets, timestamp } from "./lib.ts";
import type { BuildScore, Mode, Target } from "./lib.ts";
import { compareEvals, evalScore, lintCandidate, splitTargets, stopReason, worstBuilds } from "./objective.ts";
import type { Comparison, MeanSe } from "./objective.ts";
import { writeOptimizeReport } from "./optimize-report.ts";
import { BENCH, loadTargets, runBench } from "./run.ts";
import { holdoutReserve, PROPOSER_SLACK_USD, readJson, restoreLoop, savedProposal } from "./resume.ts";
import type { Attempt, HistoryEntry } from "./resume.ts";
import { buildDirs, currentScore, scoreRun } from "./score.ts";
import { parseClaudeOutput, run, runClaude, SKILL_FILES } from "./tools.ts";

const REPO = dirname(BENCH);
const MAX_SKILL_LINES = 95;
const EXTRA_BANNED = ["Stripe", "Escalation Watch", "Payvora"];

export type OptimizeOptions = {
  rounds: number; samples: number; budgetUsd: number; holdoutSamples: number;
  trainTargets: string[] | null; holdoutTargets: string[] | null;
  model: string; judgeModel: string; proposerModel: string; concurrency: number; buildBudgetUsd: number; out: string | null;
};

function num(flags: Map<string, string>, key: string, fallback: number): number {
  const v = flags.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive number`);
  return n;
}

const FLAGS = new Set(["rounds", "samples", "budget-usd", "holdout-samples", "train-targets", "holdout-targets", "model", "judge-model", "proposer-model", "concurrency", "build-budget-usd", "out"]);

export function parseOptimizeArgs(argv: string[]): OptimizeOptions {
  const flags = readFlags(argv);
  const unknown = [...flags.keys()].filter(k => !FLAGS.has(k));
  if (unknown.length) throw new Error(`unknown flag: --${unknown.join(", --")}`);
  const ids = (key: string) => flags.get(key)?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
  const samples = Math.round(num(flags, "samples", 2));
  return {
    rounds: Math.round(num(flags, "rounds", 5)), samples, budgetUsd: num(flags, "budget-usd", 45),
    holdoutSamples: Math.round(num(flags, "holdout-samples", samples)),
    trainTargets: ids("train-targets"), holdoutTargets: ids("holdout-targets"),
    model: flags.get("model") ?? "sonnet", judgeModel: flags.get("judge-model") ?? "opus", proposerModel: flags.get("proposer-model") ?? "opus",
    concurrency: Math.round(num(flags, "concurrency", 5)), buildBudgetUsd: num(flags, "build-budget-usd", 5), out: flags.get("out") ?? null,
  };
}

type Eval = { name: string; out: string; scores: BuildScore[]; byMode: Record<string, BuildScore[]>; cost: number; builds: number };

type Ctx = { opt: string; options: OptimizeOptions; train: Target[]; holdout: Target[]; spent: number; resume: boolean };

async function evaluate(ctx: Ctx, name: string, skillDir: string, targets: Target[], modes: Mode[], samples: number): Promise<Eval> {
  const out = join(ctx.opt, "evals", name);
  const o = ctx.options;
  const runInfo = await runBench({ targets: targets.map(t => t.id), modes, samples, model: o.model, concurrency: o.concurrency, out, timeoutMinutes: 20, budgetUsd: o.buildBudgetUsd, skillDir }, targets, true, ctx.resume);
  const scored = await scoreRun({ run: out, judgeModel: o.judgeModel, concurrency: o.concurrency, force: false }, true);
  const byMode: Record<string, BuildScore[]> = {};
  for (const s of scored.scores) byMode[s.mode] = [...(byMode[s.mode] ?? []), s];
  const cost = round(runInfo.cost_usd + scored.judge_cost_usd);
  ctx.spent = round(ctx.spent + cost);
  log(`eval ${name}: ${runInfo.builds} builds, ${runInfo.failed} failed, $${cost.toFixed(2)} (total $${ctx.spent.toFixed(2)})`);
  return { name, out, scores: scored.scores, byMode, cost, builds: runInfo.builds };
}

function log(line: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
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

type CaseLabel = Map<string, string>;

function metaOf(evalOut: string, s: BuildScore): Record<string, unknown> {
  const path = join(evalOut, s.target, s.mode, String(s.sample), "meta.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function buildBlock(e: Eval, s: BuildScore, labels: CaseLabel): string {
  const m = metaOf(e.out, s);
  const head = `#### ${labels.get(s.target)} sample ${s.sample}: score ${s.objective ?? "–"}, overall ${s.judge?.overall.score ?? "–"}/10, rule pass ${s.rules?.rule_pass ?? "–"}`;
  const usage = `- Skill loaded: ${m.skill_used ? "yes" : "no"}; taste CLI calls that returned data: ${m.taste_ok_calls ?? 0}/${m.taste_calls ?? 0}; library images opened: ${m.image_reads_ok ?? 0}; turns: ${m.num_turns ?? "–"}`;
  if (!s.ok) return [head, usage, `- Build failed: ${s.error ?? m.error ?? "unknown"}`].join("\n");
  const dims = DIMENSIONS.map(d => `- ${d} ${s.judge![d].score}: ${s.judge![d].reason}`);
  const misses = (s.rules?.results ?? []).filter(r => r.verdict === "misses").map(r => `- MISS ${r.rule.slice(0, 90)}: ${r.reason}`);
  return [head, usage, "Judge (target vs build):", ...dims, "Rule misses:", ...(misses.length ? misses : ["- none"])].join("\n");
}

function missedRules(scores: BuildScore[]): string[] {
  const counts = new Map<string, number>();
  for (const s of scores) for (const r of s.rules?.results ?? []) if (r.verdict === "misses") counts.set(r.rule, (counts.get(r.rule) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([rule, n]) => `- ${n}/${scores.length} builds miss: ${rule}`);
}

function attemptsBlock(attempts: Attempt[]): string {
  if (!attempts.length) return "None yet. This is the first proposal.";
  return attempts.map(a => [`### Round ${a.round}: ${a.accepted ? "ACCEPTED" : "REJECTED"} (${a.reason})`, `Proposer summary: ${a.summary.slice(0, 1200)}`, a.accepted ? "" : `Rejected diff (do not repeat it as is):\n\`\`\`diff\n${a.diff.slice(0, 5000)}\n\`\`\``].join("\n")).join("\n\n");
}

async function sideBySide(e: Eval, s: BuildScore, path: string) {
  const target = join(e.out, "targets", `${s.target}.jpg`);
  const build = join(e.out, s.target, s.mode, String(s.sample), "build.png");
  if (!existsSync(build)) return false;
  const out = await run(["magick", target, build, "-resize", "x900", "-background", "white", "-splice", "16x0", "+append", "-chop", "16x0", "+repage", path]);
  return out.code === 0;
}

async function writeFeedback(dir: string, e: Eval, score: MeanSe, labels: CaseLabel, attempts: Attempt[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const scores = e.byMode.taste ?? [];
  const pairs: string[] = [];
  for (const [i, s] of worstBuilds(scores, 3).entries()) {
    const name = `pair-${i + 1}.png`;
    if (await sideBySide(e, s, join(dir, name))) pairs.push(`- ${name}: ${labels.get(s.target)} sample ${s.sample} (score ${s.objective}). Left = target, right = build.`);
  }
  const cases = [...labels].map(([id, label]) => {
    const prompt = loadTargets().find(t => t.id === id)?.prompt ?? "";
    const builds = scores.filter(s => s.target === id).sort((a, b) => a.sample - b.sample).map(s => buildBlock(e, s, labels));
    return [`### ${label}`, `Prompt: ${prompt}`, ...builds].join("\n\n");
  });
  const text = [
    "# Train results for the current skill",
    `Score per build = 0.7 x (judge overall / 10) + 0.3 x (rule pass rate). Current mean: ${score.mean} +/- ${score.se} (standard error, ${score.n} builds).`,
    "## Rules most often missed", ...missedRules(scores),
    "## Worst builds, side by side", ...(pairs.length ? pairs : ["- no images"]),
    "## Every case", ...cases,
    "## Earlier proposals", attemptsBlock(attempts),
  ].join("\n\n");
  writeFileSync(join(dir, "feedback.md"), text);
}

const PROPOSER_PROMPT = `You improve a skill for a coding agent. The skill is "taste-use". It tells an agent how to build or review a user interface with the user's saved design taste: a profile of confirmed rules, plus a library of saved reference designs (screenshots) that the user collected.

The skill files are in ./skill/ (SKILL.md and references/*.md). Edit them in place. Do not create other files.

How we test the skill:
- A builder agent gets a short product prompt (for example "build a dark usage dashboard with a KPI row and a table") plus "Use my saved design taste (taste-use skill) for this."
- The builder runs headless. It has Read, Write, Edit, the Skill tool, and Bash limited to the taste CLI read commands (profile, brief, show, list, search). It writes one index.html. It cannot run a browser, so it cannot see its own page.
- "taste brief" and "taste show" print the saved references, and for screenshots they print a local image path. The builder may Read those image files.
- The page is rendered and compared with a target design. The targets come from designers the user follows, so they stand in for the user's taste. The builder never sees the target. A judge scores how close the build looks to the target, and a second judge checks the build against each profile rule.

Do this:
1. Read ./feedback/feedback.md. Then look at the side-by-side images in ./feedback/ (left = target, right = build).
2. Find the 1 to 3 changes to the skill that are most likely to make builds look closer to the targets and follow the profile rules better. Look for causes in the process: what the builder loads, what it looks at, how it plans, and how it checks its work before it finishes.
3. Edit the skill files.
4. Reply with a short list of your changes and the reason for each.

Constraints:
- Guidance must be general. It must help any user with any taste library and any project. Never name a product, brand, company, person, number, color value, or specific layout that you saw in the feedback or the images.
- Do not copy the profile rules into the skill. The builder loads them from the CLI.
- Keep SKILL.md under about 90 lines, and keep its frontmatter. Keep each reference file focused on its one job.
- Keep the plain Simplified Technical English style that the files use now: short sentences, active voice, common words.
- Prefer process changes (what to load, what to look at, how to check) over long lists of rules.
- The skill must still work in a normal project where the agent can run a browser. Do not remove guidance that is only wrong for this test setup; make it conditional instead.
- Read "Earlier proposals" in the feedback. Do not repeat a rejected change.`;

type Proposal = { dir: string; summary: string; cost: number; error?: string };

async function propose(ctx: Ctx, k: number, incumbentDir: string, e: Eval, score: MeanSe, labels: CaseLabel, attempts: Attempt[]): Promise<Proposal> {
  const roundDir = join(ctx.opt, `round-${k}`);
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "bench-proposer-")));
  try {
    copySkill(incumbentDir, join(ws, "skill"));
    await writeFeedback(join(ws, "feedback"), e, score, labels, attempts);
    cpSync(join(ws, "feedback"), join(roundDir, "feedback"), { recursive: true });
    const result = await runClaude({
      prompt: PROPOSER_PROMPT, cwd: ws, model: ctx.options.proposerModel, tools: ["Read", "Edit", "Write"],
      allowed: [`Read(/${ws}/**)`, `Edit(/${ws}/skill/**)`, `Write(/${ws}/skill/**)`], timeoutMs: 20 * 60_000, budgetUsd: 4,
    });
    writeFileSync(join(roundDir, "proposer-transcript.json"), result.raw);
    const dir = join(roundDir, "candidate");
    copySkill(join(ws, "skill"), dir);
    const cost = round(result.cost_usd ?? 0);
    ctx.spent = round(ctx.spent + cost);
    return { dir, summary: result.text.trim(), cost, error: result.ok ? undefined : result.error };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

function bannedWords(targets: Target[]): string[] {
  return [...targets.flatMap(t => [t.id, t.author, `@${t.author}`]), ...EXTRA_BANNED];
}

function sameSkill(a: string, b: string): boolean {
  const x = readSkill(a);
  const y = readSkill(b);
  return SKILL_FILES.every(f => x[f] === y[f]);
}

function precheck(dir: string, incumbentDir: string, banned: string[]): string[] {
  if (sameSkill(dir, incumbentDir)) return ["the proposer made no edits"];
  const files = readSkill(dir);
  const { "SKILL.md": skill, ...refs } = files;
  return lintCandidate({ skill: skill!, files: refs, banned, maxSkillLines: MAX_SKILL_LINES });
}

function writeHistory(opt: string, history: HistoryEntry[]) {
  writeFileSync(join(opt, "history.json"), JSON.stringify(history, null, 2));
}

type Incumbent = { dir: string; round: number; eval: Eval; score: MeanSe };

type LoopState = { inc: Incumbent; history: HistoryEntry[]; attempts: Attempt[]; streak: number; lastRoundCost: number };

function verdict(cmp: Comparison): string {
  const sign = cmp.diff >= 0 ? "+" : "";
  return `${cmp.accept ? "beats" : "does not beat"} incumbent: paired diff ${sign}${cmp.diff} vs threshold ${cmp.threshold} (se ${cmp.se}, ${cmp.targets} targets)`;
}

async function oneRound(ctx: Ctx, k: number, st: LoopState, labels: CaseLabel, saved: Proposal | null = null): Promise<void> {
  log(saved ? `round ${k}: reusing saved proposal` : `round ${k}: proposing from round ${st.inc.round}`);
  const p = saved ?? await propose(ctx, k, st.inc.dir, st.inc.eval, st.inc.score, labels, st.attempts);
  const diff = await skillDiff(st.inc.dir, p.dir);
  const problems = p.error ? [`proposer failed: ${p.error}`] : precheck(p.dir, st.inc.dir, bannedWords([...ctx.train, ...ctx.holdout]));
  let e: Eval | null = null;
  let cmp: Comparison | null = null;
  if (!problems.length) {
    e = await evaluate(ctx, `round-${k}-train`, p.dir, ctx.train, ["taste"], ctx.options.samples);
    cmp = compareEvals(st.inc.eval.byMode.taste ?? [], e.byMode.taste ?? []);
  }
  const accepted = !!cmp?.accept;
  const reason = cmp ? verdict(cmp) : `rejected before eval: ${problems.join("; ")}`;
  const score = e ? evalScore(e.byMode.taste ?? []) : null;
  const evalCost = e?.cost ?? 0;
  st.history.push({ round: k, candidate_dir: p.dir, parent_dir: st.inc.dir, diff, lint: problems, proposer_summary: p.summary, train: score, incumbent: st.inc.score, comparison: cmp, accepted, reason, cost: { proposer: p.cost, eval: evalCost, total: round(p.cost + evalCost) }, spent_after: ctx.spent });
  st.attempts.push({ round: k, accepted, reason, summary: p.summary, diff });
  st.lastRoundCost = Math.max(st.lastRoundCost, p.cost + evalCost);
  st.streak = accepted ? 0 : st.streak + 1;
  if (accepted && e && score) st.inc = { dir: p.dir, round: k, eval: e, score };
  log(`round ${k}: ${accepted ? "ACCEPTED" : "rejected"}. ${reason}`);
  writeHistory(ctx.opt, st.history);
}

async function holdoutEvals(ctx: Ctx, original: string, best: Incumbent) {
  const samples = ctx.options.holdoutSamples;
  const base = await evaluate(ctx, "holdout-original", original, ctx.holdout, ["baseline", "taste"], samples);
  const bestEval = best.round === 0 ? base : await evaluate(ctx, "holdout-best", best.dir, ctx.holdout, ["taste"], samples);
  return { baseline: base.byMode.baseline ?? [], original: base.byMode.taste ?? [], best: bestEval.byMode.taste ?? [], dirs: { original: base.out, best: bestEval.out } };
}

function armSummary(scores: BuildScore[]) {
  const mean = (f: (s: BuildScore) => number | null | undefined) => evalScore(scores.map(s => ({ target: s.target, objective: f(s) ?? null })));
  return { score: evalScore(scores), overall: mean(s => s.judge?.overall.score), rule_pass: mean(s => s.rules?.rule_pass) };
}

function resolveTargets(all: Target[], split: "train" | "holdout", ids: string[] | null): Target[] {
  const pool = splitTargets(all, split);
  if (!ids) return pool;
  const bad = ids.filter(id => !pool.some(t => t.id === id));
  if (bad.length) throw new Error(`not ${split} targets: ${bad.join(", ")}`);
  return selectTargets(pool, ids);
}

type Setup = { ctx: Ctx; labels: CaseLabel; original: string; st: LoopState; s0: MeanSe; reserve: number; saved: Proposal | null };

function labelsFor(train: Target[]): CaseLabel {
  return new Map(train.map((t, i) => [t.id, `case-${i + 1}`]));
}

async function freshSetup(options: OptimizeOptions): Promise<Setup> {
  const all = loadTargets();
  const opt = resolve(options.out ?? join(BENCH, "optimize", timestamp()));
  mkdirSync(opt, { recursive: true });
  const ctx: Ctx = { opt, options, train: resolveTargets(all, "train", options.trainTargets), holdout: resolveTargets(all, "holdout", options.holdoutTargets), spent: 0, resume: false };
  writeFileSync(join(opt, "options.json"), JSON.stringify({ ...options, train: ctx.train.map(t => t.id), holdout: ctx.holdout.map(t => t.id) }, null, 2));
  const original = originalSkill(opt);
  log(`optimize ${opt}: train ${ctx.train.length} targets x ${options.samples}, holdout ${ctx.holdout.length} x ${options.holdoutSamples}, budget $${options.budgetUsd}`);
  const e0 = await evaluate(ctx, "round-0-train", original, ctx.train, ["taste"], options.samples);
  const s0 = evalScore(e0.byMode.taste ?? []);
  const st: LoopState = { inc: { dir: original, round: 0, eval: e0, score: s0 }, history: [], attempts: [], streak: 0, lastRoundCost: e0.cost + PROPOSER_SLACK_USD };
  st.history.push({ round: 0, candidate_dir: original, parent_dir: null, diff: "", lint: [], proposer_summary: "original skill", train: s0, incumbent: null, comparison: null, accepted: true, reason: "starting point", cost: { proposer: 0, eval: e0.cost, total: e0.cost }, spent_after: ctx.spent });
  writeHistory(opt, st.history);
  log(`round 0 (original): train ${s0.mean} +/- ${s0.se}`);
  const reserve = holdoutReserve(e0.cost, e0.builds, ctx.holdout.length, options.holdoutSamples);
  return { ctx, labels: labelsFor(ctx.train), original, st, s0, reserve, saved: null };
}

function savedEval(opt: string, name: string, cost: number): Eval {
  const out = join(opt, "evals", name);
  if (!existsSync(out)) throw new Error(`missing eval folder ${out}`);
  const scores = buildDirs(out).map(d => readJson<BuildScore>(join(d, "score.json")));
  if (scores.some(s => !currentScore(s))) throw new Error(`eval ${name} has builds without a current score.json`);
  const byMode: Record<string, BuildScore[]> = {};
  for (const s of scores as BuildScore[]) byMode[s.mode] = [...(byMode[s.mode] ?? []), s];
  return { name, out, scores: scores as BuildScore[], byMode, cost, builds: scores.length };
}

function pickTargets(all: Target[], ids: string[]): Target[] {
  return ids.map(id => {
    const t = all.find(x => x.id === id);
    if (!t) throw new Error(`unknown target in options.json: ${id}`);
    return t;
  });
}

function savedRoundProposal(opt: string, k: number): Proposal | null {
  const roundDir = join(opt, `round-${k}`);
  const dir = join(roundDir, "candidate");
  const raw = existsSync(join(roundDir, "proposer-transcript.json")) ? readFileSync(join(roundDir, "proposer-transcript.json"), "utf8") : null;
  const p = savedProposal(SKILL_FILES.map(f => existsSync(join(dir, f))), raw === null ? null : parseClaudeOutput(raw));
  return p ? { dir, ...p } : null;
}

function prepareInterrupted(ctx: Ctx, k: number): Proposal | null {
  const saved = savedRoundProposal(ctx.opt, k);
  if (saved) {
    ctx.spent = round(ctx.spent + saved.cost);
    log(`round ${k}: saved proposal found ($${saved.cost.toFixed(2)}); its eval will reuse finished builds`);
    return saved;
  }
  rmSync(join(ctx.opt, "evals", `round-${k}-train`), { recursive: true, force: true });
  return null;
}

async function resumeSetup(dir: string): Promise<Setup> {
  const opt = resolve(dir);
  const stored = readJson<OptimizeOptions & { train: string[]; holdout: string[] }>(join(opt, "options.json"));
  const history = readJson<HistoryEntry[]>(join(opt, "history.json"));
  if (!stored || !history) throw new Error(`${opt} needs options.json and history.json`);
  const all = loadTargets();
  const restored = restoreLoop(history);
  const ctx: Ctx = { opt, options: stored, train: pickTargets(all, stored.train), holdout: pickTargets(all, stored.holdout), spent: restored.spent, resume: true };
  const original = join(opt, "original");
  const e0 = savedEval(opt, "round-0-train", history[0]!.cost.eval);
  const inc = restored.incumbent;
  const incEval = inc.round === 0 ? e0 : savedEval(opt, `round-${inc.round}-train`, inc.cost.eval);
  const st: LoopState = { inc: { dir: inc.candidate_dir, round: inc.round, eval: incEval, score: inc.train! }, history, attempts: restored.attempts, streak: restored.streak, lastRoundCost: restored.lastRoundCost };
  const reserve = holdoutReserve(e0.cost, e0.builds, ctx.holdout.length, stored.holdoutSamples);
  log(`resume ${opt}: ${history.length} rounds in history, incumbent round ${inc.round}, spent $${ctx.spent.toFixed(2)}, reject streak ${st.streak}`);
  return { ctx, labels: labelsFor(ctx.train), original, st, s0: history[0]!.train!, reserve, saved: prepareInterrupted(ctx, restored.nextRound) };
}

async function runLoop(setup: Setup): Promise<string> {
  const { ctx, st, labels, reserve } = setup;
  const o = ctx.options;
  let saved = setup.saved;
  let stop: string | null = null;
  for (let k = st.history.at(-1)!.round + 1; !stop; k++) {
    stop = stopReason({ round: k, rounds: o.rounds, spent: ctx.spent, nextRound: st.lastRoundCost, reserve, budget: o.budgetUsd, rejectStreak: st.streak });
    if (!stop) await oneRound(ctx, k, st, labels, saved);
    saved = null;
  }
  return stop;
}

async function finish(setup: Setup, stop: string) {
  const { ctx, st, original, s0 } = setup;
  log(`stop: ${stop}. Best is round ${st.inc.round}. Running holdout.`);
  const h = await holdoutEvals(ctx, original, st.inc);
  const final = {
    stop_reason: stop, best_round: st.inc.round, best_dir: st.inc.dir, original_dir: original, train_best: st.inc.score, train_original: s0,
    holdout_targets: ctx.holdout.map(t => t.id), holdout_samples: ctx.options.holdoutSamples,
    holdout: { baseline: armSummary(h.baseline), original: armSummary(h.original), best: armSummary(h.best) },
    holdout_compare: { best_vs_original: compareEvals(h.original, h.best), original_vs_baseline: compareEvals(h.baseline, h.original), best_vs_baseline: compareEvals(h.baseline, h.best) },
    holdout_runs: h.dirs, total_cost_usd: ctx.spent,
  };
  writeFileSync(join(ctx.opt, "final.json"), JSON.stringify(final, null, 2));
  await writeOptimizeReport(ctx.opt, final, st.history, await skillDiff(original, st.inc.dir));
  log(`done. total $${ctx.spent.toFixed(2)}. ${join(ctx.opt, "report.html")}`);
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
  const setup = dir ? await resumeSetup(dir) : await freshSetup(parseOptimizeArgs(argv));
  await finish(setup, await runLoop(setup));
}

if (import.meta.main) await main();
