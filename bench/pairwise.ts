import { extractJsonObject, round } from "./lib.ts";

export const SIDES = ["left", "right", "tie"] as const;
export type Side = (typeof SIDES)[number];
export type Arm = "a" | "b";
export type Vote = Arm | "tie";
export type Order = "ab" | "ba";
export const ORDERS: Order[] = ["ab", "ba"];
export const QUESTIONS = ["closer", "rules", "calmer"] as const;
export type Question = (typeof QUESTIONS)[number];

export type PairVerdict = Record<Question, Side> & { [K in Question as `${K}_reason`]: string };
export type PairKey = { target: string; sample: number };
export type PairCall = PairKey & { order: Order };
export type CallResult = PairCall & { verdict?: PairVerdict; auto?: Vote; cost: number; error?: string };
export type PairOutcome = PairKey & Record<Question, Vote | null> & { split: Record<Question, boolean>; reasons: Record<Question, { winner: Arm; reason: string }[]> };
export type WinStats = { wins: number; losses: number; ties: number; n: number; win_rate: number | null; p: number };
export type AcceptRule = { on: Question; minWinRate: number; maxP: number; minGuardRate: number; guardLossP: number; guards?: Question[] };
export type Decision = { accept: boolean; reason: string };
export type PairSummary = Record<Question, WinStats> & { pairs: number; split: Record<Question, number>; judge_errors: number };

export function pairPrompt(rules: string[]): string {
  const list = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  return `You compare two UI builds against one target design. Three images are in the current directory:
- 1-target.jpg is the TARGET design.
- 2-left.png is the LEFT build.
- 3-right.png is the RIGHT build.
Both builds are web pages made from the same short text prompt. Read all three images in one step.

Ignore any gray backdrop, device frame or drop shadow around the target; compare the app screen itself. Do not reward or punish the exact sample text or numbers.

Answer three questions:
1. closer: which build looks closer to the target as a whole (layout, density, type, color, components, detail)?
2. rules: which build follows these design rules better? Judge only from what you can see.
${list}
3. calmer: which build is calmer and less busy, with fewer competing elements, badges, accents and columns, while it still shows what the screen needs? A build that leaves out what the screen needs is not calmer, only emptier.

Pick "tie" only when you truly cannot choose. In each reason, say what the better build does that the other does not. Do not say left or right in a reason; say "the better build" and "the other build".

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape:
{"closer":"left","closer_reason":"one line","rules":"right","rules_reason":"one line","calmer":"tie","calmer_reason":"one line"}`;
}

function side(value: unknown, name: string): Side {
  const v = String(value ?? "").trim().toLowerCase();
  if (!(SIDES as readonly string[]).includes(v)) throw new Error(`pair judge ${name} must be left, right or tie, got ${String(value)}`);
  return v as Side;
}

function reason(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`pair judge ${name} has no reason`);
  return value.trim();
}

export function parsePairVerdict(text: string): PairVerdict {
  const raw = extractJsonObject(text) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const q of QUESTIONS) {
    out[q] = side(raw[q], q);
    out[`${q}_reason`] = reason(raw[`${q}_reason`], `${q}_reason`);
  }
  return out as PairVerdict;
}

export function leftArm(order: Order): Arm {
  return order === "ab" ? "a" : "b";
}

export function sideToVote(s: Side, order: Order): Vote {
  if (s === "tie") return "tie";
  const left = leftArm(order);
  return s === "left" ? left : left === "a" ? "b" : "a";
}

export function pairCalls(keys: PairKey[]): PairCall[] {
  return keys.flatMap(k => ORDERS.map(order => ({ ...k, order })));
}

export function pairFile(call: PairCall): string {
  return `${call.target}-${call.sample}-${call.order}.json`;
}

export function autoVote(aOk: boolean, bOk: boolean): Vote | "judge" | null {
  if (aOk && bOk) return "judge";
  if (aOk) return "a";
  if (bOk) return "b";
  return null;
}

const weight = (v: Vote | null): number => (v === "b" ? 1 : v === "a" ? -1 : 0);

export function combineVotes(votes: (Vote | null)[]): Vote | null {
  const known = votes.filter((v): v is Vote => v !== null);
  if (!known.length) return null;
  const sum = known.reduce((acc, v) => acc + weight(v), 0);
  return sum > 0 ? "b" : sum < 0 ? "a" : "tie";
}

export function isSplit(votes: (Vote | null)[]): boolean {
  return votes.includes("a") && votes.includes("b");
}

function voteOf(r: CallResult, q: Question): Vote | null {
  if (r.auto) return r.auto;
  return r.verdict ? sideToVote(r.verdict[q], r.order) : null;
}

function reasonsOf(results: CallResult[], q: Question): { winner: Arm; reason: string }[] {
  const out: { winner: Arm; reason: string }[] = [];
  for (const r of results) {
    const v = voteOf(r, q);
    if (r.verdict && v && v !== "tie") out.push({ winner: v, reason: r.verdict[`${q}_reason`] });
  }
  return out;
}

export function outcomes(results: CallResult[]): PairOutcome[] {
  const groups = new Map<string, CallResult[]>();
  for (const r of results) groups.set(`${r.target}\u0000${r.sample}`, [...(groups.get(`${r.target}\u0000${r.sample}`) ?? []), r]);
  return [...groups.values()].map(rs => {
    const votes = (q: Question) => rs.map(r => voteOf(r, q));
    const per = <T>(f: (q: Question) => T) => Object.fromEntries(QUESTIONS.map(q => [q, f(q)])) as Record<Question, T>;
    return { target: rs[0]!.target, sample: rs[0]!.sample, ...per(q => combineVotes(votes(q))), split: per(q => isSplit(votes(q))), reasons: per(q => reasonsOf(rs, q)) };
  });
}

function choose(n: number, k: number): number {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
}

export function signTestP(wins: number, n: number): number {
  if (n <= 0) return 1;
  let tail = 0;
  for (let k = wins; k <= n; k++) tail += choose(n, k);
  return round(tail / 2 ** n);
}

export function winStats(votes: (Vote | null)[]): WinStats {
  const wins = votes.filter(v => v === "b").length;
  const losses = votes.filter(v => v === "a").length;
  const ties = votes.filter(v => v === "tie").length;
  const n = wins + losses;
  return { wins, losses, ties, n, win_rate: n ? round(wins / n) : null, p: signTestP(wins, n) };
}

export function summarizePairs(list: PairOutcome[], results: CallResult[]): PairSummary {
  const per = <T>(f: (q: Question) => T) => Object.fromEntries(QUESTIONS.map(q => [q, f(q)])) as Record<Question, T>;
  return { ...per(q => winStats(list.map(o => o[q]))), pairs: list.length, split: per(q => list.filter(o => o.split[q]).length), judge_errors: results.filter(r => !r.auto && !r.verdict).length };
}

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

export function statLine(s: WinStats): string {
  return `${s.wins}-${s.losses}-${s.ties} (win rate ${pct(s.win_rate)} over ${s.n} non-ties, p ${s.p.toFixed(3)})`;
}

export function guardsOf(rule: AcceptRule): Question[] {
  return rule.guards ?? QUESTIONS.filter(q => q !== rule.on);
}

function guardProblem(name: Question, g: WinStats | undefined, rule: AcceptRule): string | null {
  if (!g) return null;
  if (g.win_rate !== null && g.win_rate < rule.minGuardRate) return `${name} win rate below guard ${rule.minGuardRate}`;
  const lossP = signTestP(g.losses, g.n);
  return lossP < rule.guardLossP ? `${name} loses clearly (p ${lossP.toFixed(3)} < ${rule.guardLossP})` : null;
}

export function decide(summary: PairSummary, rule: AcceptRule): Decision {
  const main = summary[rule.on];
  const guards = guardsOf(rule);
  const why = [rule.on, ...guards].filter(q => summary[q]).map(q => `${q} ${statLine(summary[q])}`).join("; ");
  if (main.win_rate === null) return { accept: false, reason: `no non-tie pairs on ${rule.on}. ${why}` };
  if (main.win_rate < rule.minWinRate) return { accept: false, reason: `${rule.on} win rate below ${rule.minWinRate}. ${why}` };
  if (main.p >= rule.maxP) return { accept: false, reason: `${rule.on} p not below ${rule.maxP}. ${why}` };
  const problems = guards.map(q => guardProblem(q, summary[q], rule)).filter(Boolean);
  if (problems.length) return { accept: false, reason: `${problems.join("; ")}. ${why}` };
  return { accept: true, reason: `beats incumbent. ${why}` };
}

export function pickBest<T extends { decision: Decision; summary: PairSummary }>(cands: T[], on: Question): T | null {
  const ok = cands.filter(c => c.decision.accept);
  ok.sort((x, y) => (y.summary[on].win_rate ?? 0) - (x.summary[on].win_rate ?? 0) || x.summary[on].p - y.summary[on].p || y.summary[on].wins - x.summary[on].wins);
  return ok[0] ?? null;
}

export type CostTotals = { build_usd: number; builds: number; score_usd: number; scored: number; pair_usd: number; pairs: number; proposer_usd: number; proposers: number };
export type UnitCosts = { build: number; score: number; pair: number; proposer: number };
export const DEFAULT_UNITS: UnitCosts = { build: 0.25, score: 0.3, pair: 0.12, proposer: 0.5 };
export const EMPTY_TOTALS: CostTotals = { build_usd: 0, builds: 0, score_usd: 0, scored: 0, pair_usd: 0, pairs: 0, proposer_usd: 0, proposers: 0 };

export function addTotals(a: CostTotals, b: Partial<CostTotals>): CostTotals {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof CostTotals)[]) out[k] = round(out[k] + (b[k] ?? 0));
  return out;
}

export function unitCosts(t: CostTotals, fallback = DEFAULT_UNITS): UnitCosts {
  const per = (usd: number, n: number, d: number) => (n > 0 ? round(usd / n) : d);
  return { build: per(t.build_usd, t.builds, fallback.build), score: per(t.score_usd, t.scored, fallback.score), pair: per(t.pair_usd, t.pairs, fallback.pair), proposer: per(t.proposer_usd, t.proposers, fallback.proposer) };
}

export function roundEstimate(u: UnitCosts, builds: number, candidates: number): number {
  return round(builds * (u.build + u.score) + candidates * (u.proposer + builds * u.build + 2 * builds * u.pair));
}

export function holdoutEstimate(u: UnitCosts, builds: number, bestDiffers: boolean): number {
  const arms = bestDiffers ? 3 : 2;
  const comparisons = bestDiffers ? 2 : 1;
  return round(arms * builds * (u.build + u.score) + comparisons * 2 * builds * u.pair);
}

export type BudgetState = { round: number; rounds: number; spent: number; units: UnitCosts; builds: number; maxCandidates: number; reserve: number; budget: number };
export type RoundPlan = { candidates: number; estimate: number; stop: string | null };

export function planRound(s: BudgetState): RoundPlan {
  if (s.round > s.rounds) return { candidates: 0, estimate: 0, stop: `finished ${s.rounds} rounds` };
  for (let c = s.maxCandidates; c >= 1; c--) {
    const estimate = roundEstimate(s.units, s.builds, c);
    if (s.spent + estimate + s.reserve <= s.budget) return { candidates: c, estimate, stop: null };
  }
  const one = roundEstimate(s.units, s.builds, 1);
  return { candidates: 0, estimate: one, stop: `budget: spent $${s.spent.toFixed(2)} + a 1-candidate round about $${one.toFixed(2)} + holdout reserve $${s.reserve.toFixed(2)} > $${s.budget.toFixed(2)}` };
}

export function focusOrder<T>(focuses: T[], round: number, count: number): T[] {
  const start = (round - 1) % focuses.length;
  return [...focuses.slice(start), ...focuses.slice(0, start)].slice(0, count);
}
