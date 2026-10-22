import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeArg } from "../bench/optimize.ts";
import { attemptsFrom, metaMatches, readJson, restoreRounds, savedProposal, splitJobs } from "../bench/resume.ts";
import type { CandidateRecord, RoundRecord } from "../bench/resume.ts";
import { EMPTY_TOTALS } from "../bench/pairwise.ts";
import { currentScore } from "../bench/score.ts";
import type { BuildScore } from "../bench/lib.ts";

const ms = { n: 10, mean: 0.6, se: 0.01 };
const cand = (round: number, focus: string, accepted: boolean): CandidateRecord => ({
  focus, dir: `/opt/round-${round}/cand-${focus}/candidate`, diff: `diff ${round} ${focus}`, lint: [], summary: `summary ${focus}`, eval_dir: null,
  pairs: null, accepted, reason: accepted ? "beats" : "no", losses: [`closer: loss ${focus}`], cost: { proposer: 0.3, builds: 2, pairs: 1, total: 3.3 },
});
const roundRec = (round: number, incumbent: string, from: number, promoted: string | null, spent: number, candidates: CandidateRecord[]): RoundRecord => ({
  round, incumbent_dir: incumbent, incumbent_from: from, incumbent_eval: `/opt/evals/round-${round}-incumbent`, incumbent_score: { score: ms, overall: ms, rule_pass: ms },
  candidates, promoted, cost: 10, spent_after: spent, totals: { ...EMPTY_TOTALS, builds: round * 40, build_usd: round * 9 },
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
  test("an empty history starts round 1 from the original", () => {
    expect(restoreRounds([], "/opt/original")).toEqual({ incumbentDir: "/opt/original", incumbentFrom: 0, spent: 0, totals: EMPTY_TOTALS, attempts: [], nextRound: 1 });
  });

  test("keeps the incumbent when no candidate was promoted", () => {
    const r = restoreRounds([roundRec(1, "/opt/original", 0, null, 18, [cand(1, "craft", false), cand(1, "process", false)])], "/opt/original");
    expect(r).toMatchObject({ incumbentDir: "/opt/original", incumbentFrom: 0, spent: 18, nextRound: 2 });
    expect(r.totals.builds).toBe(40);
    expect(r.attempts.map(a => [a.focus, a.accepted, a.losses[0]])).toEqual([["craft", false, "closer: loss craft"], ["process", false, "closer: loss process"]]);
  });

  test("takes the promoted candidate of the last round, not one that only passed", () => {
    const history = [
      roundRec(1, "/opt/original", 0, "rules", 18, [cand(1, "craft", true), cand(1, "rules", true)]),
      roundRec(2, "/opt/round-1/cand-rules/candidate", 1, null, 36, [cand(2, "craft", false)]),
    ];
    const r = restoreRounds(history, "/opt/original");
    expect(r).toMatchObject({ incumbentDir: "/opt/round-1/cand-rules/candidate", incumbentFrom: 1, spent: 36, nextRound: 3 });
    expect(attemptsFrom(history).map(a => [a.round, a.focus, a.accepted])).toEqual([[1, "craft", false], [1, "rules", true], [2, "craft", false]]);
  });

  test("a promotion in the last round becomes the incumbent", () => {
    const r = restoreRounds([roundRec(1, "/opt/original", 0, "craft", 18, [cand(1, "craft", true)])], "/opt/original");
    expect(r).toMatchObject({ incumbentDir: "/opt/round-1/cand-craft/candidate", incumbentFrom: 1 });
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
