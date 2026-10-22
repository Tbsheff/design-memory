import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeArg } from "../bench/optimize.ts";
import {
  attemptsFrom, holdoutReserve, largestRoundCost, metaMatches, readJson, rejectStreak, restoreLoop, savedProposal, splitJobs,
} from "../bench/resume.ts";
import type { HistoryEntry } from "../bench/resume.ts";
import { currentScore } from "../bench/score.ts";
import type { BuildScore } from "../bench/lib.ts";

const entry = (round: number, accepted: boolean, total: number, spent: number, evalCost = total): HistoryEntry => ({
  round, candidate_dir: `/opt/round-${round}/candidate`, parent_dir: round ? "/opt/original" : null, diff: `diff ${round}`, lint: [],
  proposer_summary: `summary ${round}`, train: { n: 10, mean: 0.6 + round / 100, se: 0.01 }, incumbent: null, comparison: null,
  accepted, reason: accepted ? "ok" : "no gain", cost: { proposer: total - evalCost, eval: evalCost, total }, spent_after: spent,
});

describe("which builds are missing", () => {
  type J = { target: string; mode: string; sample: number };
  const jobs: J[] = [1, 2].flatMap(sample => ["a", "b"].map(target => ({ target, mode: "taste", sample })));
  const key = (j: J) => j;

  test("reuses builds whose meta.json matches and builds the rest", () => {
    const saved = new Map<string, unknown>([["a/1", { target: "a", mode: "taste", sample: 1, ok: true }], ["b/2", { target: "b", mode: "taste", sample: 2, ok: false }]]);
    const split = splitJobs(jobs, key, j => saved.get(`${j.target}/${j.sample}`) ?? null);
    expect(split.reuse.map(r => `${r.job.target}/${r.job.sample}`)).toEqual(["a/1", "b/2"]);
    expect(split.todo.map(j => `${j.target}/${j.sample}`)).toEqual(["b/1", "a/2"]);
  });

  test("a meta.json for another job or a broken one does not count", () => {
    expect(metaMatches({ target: "a", mode: "taste", sample: 2 }, { target: "a", mode: "taste", sample: 1 })).toBe(false);
    expect(metaMatches({ target: "a", mode: "baseline", sample: 1 }, { target: "a", mode: "taste", sample: 1 })).toBe(false);
    expect(metaMatches(null, { target: "a", mode: "taste", sample: 1 })).toBe(false);
    expect(metaMatches("x", { target: "a", mode: "taste", sample: 1 })).toBe(false);
  });

  test("with nothing saved every job is built", () => {
    expect(splitJobs(jobs, key, () => null).todo).toHaveLength(4);
  });

  test("readJson gives null for a missing or half-written file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-resume-"));
    writeFileSync(join(dir, "bad.json"), '{"target": "a", ');
    writeFileSync(join(dir, "good.json"), '{"target": "a"}');
    expect(readJson(join(dir, "missing.json"))).toBeNull();
    expect(readJson(join(dir, "bad.json"))).toBeNull();
    expect(readJson(join(dir, "good.json"))).toEqual({ target: "a" });
  });

  test("only a current score.json counts as scored", () => {
    const base = { target: "a", mode: "taste", sample: 1 } as const;
    expect(currentScore(null)).toBe(false);
    expect(currentScore({ ...base, ok: true, judge_scale: 10, rules: { results: [], meets: 0, misses: 0, na: 0, rule_pass: null } } as BuildScore)).toBe(true);
    expect(currentScore({ ...base, ok: true, judge_scale: 10 } as BuildScore)).toBe(false);
    expect(currentScore({ ...base, ok: true, judge_scale: 5, rules: { results: [], meets: 0, misses: 0, na: 0, rule_pass: null } } as BuildScore)).toBe(false);
    expect(currentScore({ ...base, ok: false, judge_scale: 10 } as BuildScore)).toBe(true);
  });
});

describe("restoring the loop", () => {
  test("keeps the original as incumbent after a rejection and counts spent cost", () => {
    const history = [entry(0, true, 5.0158, 5.0158), entry(1, false, 5.2919, 10.3077, 5.0357)];
    const r = restoreLoop(history);
    expect(r.incumbent.round).toBe(0);
    expect(r.spent).toBe(10.3077);
    expect(r.streak).toBe(1);
    expect(r.nextRound).toBe(2);
    expect(r.lastRoundCost).toBeCloseTo(7.0158, 6);
    expect(r.attempts).toEqual([{ round: 1, accepted: false, reason: "no gain", summary: "summary 1", diff: "diff 1" }]);
  });

  test("picks the last accepted round and resets the streak", () => {
    const history = [entry(0, true, 5, 5), entry(1, true, 5.5, 10.5), entry(2, false, 9, 19.5), entry(3, true, 5, 24.5)];
    const r = restoreLoop(history);
    expect(r.incumbent.round).toBe(3);
    expect(r.incumbent.candidate_dir).toBe("/opt/round-3/candidate");
    expect(r.streak).toBe(0);
    expect(r.spent).toBe(24.5);
    expect(largestRoundCost(history)).toBe(9);
  });

  test("streak counts only trailing rejections", () => {
    expect(rejectStreak([entry(0, true, 5, 5), entry(1, false, 5, 10), entry(2, true, 5, 15), entry(3, false, 5, 20), entry(4, false, 5, 25)])).toBe(2);
    expect(attemptsFrom([entry(0, true, 5, 5)])).toEqual([]);
  });

  test("rejects a history that cannot resume", () => {
    expect(() => restoreLoop([])).toThrow();
    expect(() => restoreLoop([entry(1, true, 5, 5)])).toThrow();
    expect(() => restoreLoop([entry(0, false, 5, 5)])).toThrow("no accepted round");
  });

  test("holdout reserve matches the fresh-run formula", () => {
    expect(holdoutReserve(5, 10, 3, 2)).toBe(9);
    expect(holdoutReserve(5, 0, 3, 2)).toBe(90);
  });
});

describe("saved proposal", () => {
  const transcript = { ok: true, text: " changes \n", cost_usd: 0.31234 };

  test("reuses a complete candidate with a parsed transcript", () => {
    expect(savedProposal([true, true, true], transcript)).toEqual({ summary: "changes", cost: 0.3123, error: undefined });
  });

  test("keeps the proposer error so the round still rejects it", () => {
    expect(savedProposal([true], { ok: false, text: "", cost_usd: 1, error: "budget" })).toEqual({ summary: "", cost: 1, error: "budget" });
  });

  test("proposes again when a file or the transcript is missing", () => {
    expect(savedProposal([true, false], transcript)).toBeNull();
    expect(savedProposal([], transcript)).toBeNull();
    expect(savedProposal([true], null)).toBeNull();
    expect(savedProposal([true], { ok: false, text: "", error: "no result message" })).toBeNull();
  });
});

describe("--resume flag", () => {
  test("reads the folder and refuses other flags", () => {
    expect(resumeArg(["--rounds", "3"])).toBeNull();
    expect(resumeArg(["--resume", "bench/optimize/x"])).toBe("bench/optimize/x");
    expect(() => resumeArg(["--resume"])).toThrow("needs a folder");
    expect(() => resumeArg(["--resume", "x", "--rounds", "3"])).toThrow("no other flags");
  });

});
