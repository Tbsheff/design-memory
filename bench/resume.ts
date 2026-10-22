import { existsSync, readFileSync } from "node:fs";
import { round } from "./lib.ts";
import type { Comparison, MeanSe } from "./objective.ts";

export type Attempt = { round: number; accepted: boolean; reason: string; summary: string; diff: string };

export type HistoryEntry = {
  round: number; candidate_dir: string; parent_dir: string | null; diff: string; lint: string[]; proposer_summary: string;
  train: MeanSe | null; incumbent: MeanSe | null; comparison: Comparison | null; accepted: boolean; reason: string;
  cost: { proposer: number; eval: number; total: number }; spent_after: number;
};

export const PROPOSER_SLACK_USD = 2;

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

export function holdoutReserve(round0EvalCost: number, round0Builds: number, holdoutTargets: number, holdoutSamples: number): number {
  return round((round0EvalCost / Math.max(1, round0Builds)) * holdoutTargets * holdoutSamples * 3);
}

export function attemptsFrom(history: HistoryEntry[]): Attempt[] {
  return history.filter(h => h.round > 0).map(h => ({ round: h.round, accepted: h.accepted, reason: h.reason, summary: h.proposer_summary, diff: h.diff }));
}

export function rejectStreak(history: HistoryEntry[]): number {
  let n = 0;
  for (const h of [...history].reverse()) {
    if (h.accepted) break;
    n++;
  }
  return n;
}

export function largestRoundCost(history: HistoryEntry[]): number {
  const first = (history[0]?.cost.eval ?? 0) + PROPOSER_SLACK_USD;
  return Math.max(first, ...history.slice(1).map(h => h.cost.total));
}

export function lastAccepted(history: HistoryEntry[]): HistoryEntry {
  const entry = [...history].reverse().find(h => h.accepted);
  if (!entry) throw new Error("history has no accepted round; cannot resume");
  return entry;
}

export type RestoredLoop = { incumbent: HistoryEntry; spent: number; attempts: Attempt[]; streak: number; lastRoundCost: number; nextRound: number };

export function restoreLoop(history: HistoryEntry[]): RestoredLoop {
  if (!history.length || history[0]!.round !== 0) throw new Error("history must start with round 0");
  return {
    incumbent: lastAccepted(history),
    spent: history.at(-1)!.spent_after,
    attempts: attemptsFrom(history),
    streak: rejectStreak(history),
    lastRoundCost: largestRoundCost(history),
    nextRound: history.at(-1)!.round + 1,
  };
}

export type SavedProposal = { summary: string; cost: number; error?: string };

export function savedProposal(candidateFiles: boolean[], transcript: { ok: boolean; text: string; cost_usd?: number; error?: string } | null): SavedProposal | null {
  if (!transcript || !candidateFiles.length || candidateFiles.some(f => !f)) return null;
  if (transcript.cost_usd === undefined) return null;
  return { summary: transcript.text.trim(), cost: round(transcript.cost_usd), error: transcript.ok ? undefined : transcript.error };
}
