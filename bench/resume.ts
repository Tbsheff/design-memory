import { existsSync, readFileSync } from "node:fs";
import { round } from "./lib.ts";
import type { ArmScore } from "./objective.ts";
import type { Attempt } from "./optimize-feedback.ts";
import { EMPTY_TOTALS } from "./pairwise.ts";
import type { CostTotals, PairSummary } from "./pairwise.ts";

export function readJson<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export type JobKey = { target: string; mode: string; sample: number };

export function metaMatches(meta: unknown, key: JobKey): boolean {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Partial<JobKey>;
  return m.target === key.target && m.mode === key.mode && m.sample === key.sample;
}

export type JobSplit<J, M> = { reuse: { job: J; meta: M }[]; todo: J[] };

export function splitJobs<J, M>(jobs: J[], key: (job: J) => JobKey, savedMeta: (job: J) => M | null): JobSplit<J, M> {
  const out: JobSplit<J, M> = { reuse: [], todo: [] };
  for (const job of jobs) {
    const meta = savedMeta(job);
    if (meta && metaMatches(meta, key(job))) out.reuse.push({ job, meta });
    else out.todo.push(job);
  }
  return out;
}

export type CandidateCost = { proposer: number; builds: number; pairs: number; total: number };
export type CandidateRecord = {
  focus: string; dir: string; diff: string; lint: string[]; summary: string; eval_dir: string | null;
  pairs: PairSummary | null; accepted: boolean; reason: string; losses: string[]; cost: CandidateCost;
};
export type RoundRecord = {
  round: number; incumbent_dir: string; incumbent_from: number; incumbent_eval: string; incumbent_score: ArmScore;
  candidates: CandidateRecord[]; promoted: string | null; cost: number; spent_after: number; totals: CostTotals;
};

export function attemptsFrom(history: RoundRecord[]): Attempt[] {
  return history.flatMap(h => h.candidates.map(c => ({ round: h.round, focus: c.focus, accepted: h.promoted === c.focus, reason: c.reason, summary: c.summary, diff: c.diff, losses: c.losses })));
}

export type Restored = { incumbentDir: string; incumbentFrom: number; spent: number; totals: CostTotals; attempts: Attempt[]; nextRound: number };

export function restoreRounds(history: RoundRecord[], original: string): Restored {
  const last = history.at(-1);
  if (!last) return { incumbentDir: original, incumbentFrom: 0, spent: 0, totals: EMPTY_TOTALS, attempts: [], nextRound: 1 };
  const promoted = last.candidates.find(c => c.focus === last.promoted);
  return {
    incumbentDir: promoted ? promoted.dir : last.incumbent_dir,
    incumbentFrom: promoted ? last.round : last.incumbent_from,
    spent: last.spent_after, totals: last.totals, attempts: attemptsFrom(history), nextRound: last.round + 1,
  };
}

export type SavedProposal = { summary: string; cost: number; error?: string };

export function savedProposal(candidateFiles: boolean[], transcript: { ok: boolean; text: string; cost_usd?: number; error?: string } | null): SavedProposal | null {
  if (!transcript || !candidateFiles.length || candidateFiles.some(f => !f)) return null;
  if (transcript.cost_usd === undefined) return null;
  return { summary: transcript.text.trim(), cost: round(transcript.cost_usd), error: transcript.ok ? undefined : transcript.error };
}
