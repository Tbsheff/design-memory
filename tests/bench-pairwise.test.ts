import { describe, expect, test } from "bun:test";
import { lossReasons } from "../bench/optimize.ts";
import {
  addTotals, autoVote, focusOrder, planRound, combineVotes, decide, DEFAULT_UNITS, EMPTY_TOTALS, holdoutEstimate, isSplit, leftArm, outcomes, pairCalls, pairFile,
  pairPrompt, parsePairVerdict, pickBest, roundEstimate, sideToVote, signTestP, summarizePairs, unitCosts, winStats,
} from "../bench/pairwise.ts";
import type { AcceptRule, CallResult, PairSummary, Side, Vote } from "../bench/pairwise.ts";

const verdict = (closer: Side, rules: Side = "tie") => ({ closer, closer_reason: `c-${closer}`, rules, rules_reason: `r-${rules}` });
const call = (target: string, sample: number, order: "ab" | "ba", closer: Side, rules: Side = "tie"): CallResult => ({ target, sample, order, verdict: verdict(closer, rules), cost: 0.1 });

describe("left/right bookkeeping", () => {
  test("order ab puts the incumbent (a) left, ba puts the candidate (b) left", () => {
    expect(leftArm("ab")).toBe("a");
    expect(leftArm("ba")).toBe("b");
    expect(sideToVote("left", "ab")).toBe("a");
    expect(sideToVote("right", "ab")).toBe("b");
    expect(sideToVote("left", "ba")).toBe("b");
    expect(sideToVote("right", "ba")).toBe("a");
    expect(sideToVote("tie", "ba")).toBe("tie");
  });

  test("every pair runs in both orders with its own cache file", () => {
    const calls = pairCalls([{ target: "t", sample: 1 }, { target: "t", sample: 2 }]);
    expect(calls.map(pairFile)).toEqual(["t-1-ab.json", "t-1-ba.json", "t-2-ab.json", "t-2-ba.json"]);
  });

  test("a failed build loses without a judge call", () => {
    expect(autoVote(true, true)).toBe("judge");
    expect(autoVote(true, false)).toBe("a");
    expect(autoVote(false, true)).toBe("b");
    expect(autoVote(false, false)).toBeNull();
  });
});

describe("combining the two orders", () => {
  test("agree, win plus tie, split and both ties", () => {
    expect(combineVotes(["b", "b"])).toBe("b");
    expect(combineVotes(["b", "tie"])).toBe("b");
    expect(combineVotes(["tie", "a"])).toBe("a");
    expect(combineVotes(["a", "b"])).toBe("tie");
    expect(combineVotes(["tie", "tie"])).toBe("tie");
    expect(combineVotes(["b", null])).toBe("b");
    expect(combineVotes([null, null])).toBeNull();
    expect(isSplit(["a", "b"])).toBe(true);
    expect(isSplit(["a", "tie"])).toBe(false);
  });

  test("a judge that always says left gives a split, not a win", () => {
    const list = outcomes([call("t", 1, "ab", "left"), call("t", 1, "ba", "left")]);
    expect(list).toHaveLength(1);
    expect(list[0]!.closer).toBe("tie");
    expect(list[0]!.split.closer).toBe(true);
  });

  test("the candidate wins when it is picked on both sides, and reasons keep the winner", () => {
    const list = outcomes([call("t", 1, "ab", "right", "left"), call("t", 1, "ba", "left", "left")]);
    expect(list[0]).toMatchObject({ target: "t", sample: 1, closer: "b", rules: "tie" });
    expect(list[0]!.reasons.closer).toEqual([{ winner: "b", reason: "c-right" }, { winner: "b", reason: "c-left" }]);
    expect(list[0]!.reasons.rules).toEqual([{ winner: "a", reason: "r-left" }, { winner: "b", reason: "r-left" }]);
    expect(lossReasons(list)).toEqual(["rules: r-left"]);
  });

  test("pairs group by target and sample", () => {
    const list = outcomes([call("x", 1, "ab", "right"), call("y", 1, "ab", "left"), call("x", 1, "ba", "tie"), call("x", 2, "ba", "left")]);
    expect(list.map(o => [o.target, o.sample, o.closer])).toEqual([["x", 1, "b"], ["y", 1, "a"], ["x", 2, "b"]]);
  });
});

describe("sign test", () => {
  test("one-sided exact binomial", () => {
    expect(signTestP(7, 10)).toBeCloseTo(0.1719, 4);
    expect(signTestP(6, 10)).toBeCloseTo(0.377, 3);
    expect(signTestP(6, 8)).toBeCloseTo(0.1445, 4);
    expect(signTestP(10, 10)).toBeCloseTo(0.001, 3);
    expect(signTestP(0, 4)).toBe(1);
    expect(signTestP(0, 0)).toBe(1);
  });

  test("win stats drop ties and missing pairs from n", () => {
    const votes: (Vote | null)[] = ["b", "b", "a", "tie", null, "b"];
    expect(winStats(votes)).toEqual({ wins: 3, losses: 1, ties: 1, n: 4, win_rate: 0.75, p: 0.3125 });
    expect(winStats([]).win_rate).toBeNull();
  });
});

describe("acceptance", () => {
  const rule: AcceptRule = { on: "closer", minWinRate: 0.6, maxP: 0.2, minGuardRate: 0.4 };
  const summary = (cw: number, cl: number, rw: number, rl: number): PairSummary => ({
    closer: winStats([...Array(cw).fill("b"), ...Array(cl).fill("a")]), rules: winStats([...Array(rw).fill("b"), ...Array(rl).fill("a")]),
    pairs: 10, split: { closer: 0, rules: 0 }, judge_errors: 0,
  });

  test("7 of 10 passes, 6 of 10 fails on p", () => {
    expect(decide(summary(7, 3, 5, 5), rule).accept).toBe(true);
    const six = decide(summary(6, 4, 5, 5), rule);
    expect(six.accept).toBe(false);
    expect(six.reason).toContain("p not below");
  });

  test("a low win rate, no non-ties, or worse rules reject", () => {
    expect(decide(summary(1, 0, 0, 0), { ...rule, maxP: 0.6 }).accept).toBe(true);
    expect(decide(summary(5, 5, 5, 5), { ...rule, maxP: 1 }).reason).toContain("win rate below 0.6");
    expect(decide(summary(0, 0, 3, 0), rule).reason).toContain("no non-tie pairs");
    expect(decide(summary(8, 2, 2, 8), rule).reason).toContain("rules win rate below guard");
    expect(decide(summary(8, 2, 0, 0), rule).accept).toBe(true);
  });

  test("accept-on rules swaps main and guard", () => {
    expect(decide(summary(4, 6, 9, 1), { ...rule, on: "rules" }).accept).toBe(true);
    expect(decide(summary(9, 1, 4, 6), { ...rule, on: "rules" }).accept).toBe(false);
  });

  test("pick the passing candidate with the best win rate, then lower p", () => {
    const c = (id: string, s: PairSummary) => ({ id, summary: s, decision: decide(s, rule) });
    const list = [c("x", summary(7, 3, 5, 5)), c("y", summary(9, 1, 5, 5)), c("z", summary(10, 0, 0, 10)), c("w", summary(9, 1, 6, 4))];
    expect(pickBest(list, "closer")?.id).toBe("y");
    expect(pickBest([c("x", summary(6, 4, 5, 5))], "closer")).toBeNull();
  });

  test("summary counts splits and judge errors", () => {
    const results: CallResult[] = [call("t", 1, "ab", "left"), call("t", 1, "ba", "left"), { target: "t", sample: 2, order: "ab", cost: 0.2, error: "bad json" }, call("t", 2, "ba", "left")];
    const s = summarizePairs(outcomes(results.filter(r => r.verdict)), results);
    expect(s).toMatchObject({ pairs: 2, split: { closer: 1, rules: 0 }, judge_errors: 1 });
    expect(s.closer).toMatchObject({ wins: 1, losses: 0, ties: 1 });
  });
});

describe("pair judge reply", () => {
  test("parses sides and reasons", () => {
    expect(parsePairVerdict('ok {"closer":"Left","closer_reason":" denser ","rules":"tie","rules_reason":"same"}')).toEqual({ closer: "left", closer_reason: "denser", rules: "tie", rules_reason: "same" });
  });

  test("rejects bad sides and empty reasons", () => {
    expect(() => parsePairVerdict('{"closer":"A","closer_reason":"x","rules":"tie","rules_reason":"y"}')).toThrow("left, right or tie");
    expect(() => parsePairVerdict('{"closer":"left","closer_reason":"","rules":"tie","rules_reason":"y"}')).toThrow("no reason");
  });

  test("the prompt lists the rules and names no arm", () => {
    const p = pairPrompt(["Prefer: dense tables", "Avoid: gradients"]);
    expect(p).toContain("1. Prefer: dense tables\n2. Avoid: gradients");
    expect(p).not.toMatch(/incumbent|candidate|baseline|taste/i);
  });
});

describe("budget", () => {
  test("unit costs fall back to defaults until measured", () => {
    expect(unitCosts(EMPTY_TOTALS)).toEqual(DEFAULT_UNITS);
    const t = addTotals(EMPTY_TOTALS, { build_usd: 2.5, builds: 10, pair_usd: 1.2, pairs: 20 });
    expect(unitCosts(t)).toMatchObject({ build: 0.25, pair: 0.06, score: DEFAULT_UNITS.score });
  });

  test("round and holdout estimates", () => {
    const u = { build: 0.25, score: 0.25, pair: 0.1, proposer: 0.5 };
    expect(roundEstimate(u, 10, 3)).toBeCloseTo(5 + 3 * (0.5 + 2.5 + 2), 6);
    expect(holdoutEstimate(u, 9, true)).toBeCloseTo(3 * 9 * 0.5 + 2 * 2 * 9 * 0.1, 6);
    expect(holdoutEstimate(u, 9, false)).toBeCloseTo(2 * 9 * 0.5 + 2 * 9 * 0.1, 6);
  });

  test("plans as many candidates as the budget fits, and stops on rounds or budget, never on rejections", () => {
    const units = { build: 0.25, score: 0.25, pair: 0.1, proposer: 0.5 };
    const base = { round: 2, rounds: 5, spent: 20, units, builds: 10, maxCandidates: 3, reserve: 18, budget: 60 };
    expect(planRound(base)).toEqual({ candidates: 3, estimate: 20, stop: null });
    expect(planRound({ ...base, spent: 25 })).toMatchObject({ candidates: 2, stop: null });
    expect(planRound({ ...base, spent: 31 })).toMatchObject({ candidates: 1, stop: null });
    expect(planRound({ ...base, spent: 33 }).stop).toContain("budget");
    expect(planRound({ ...base, round: 6 }).stop).toContain("finished 5 rounds");
  });

  test("focus order rotates by round", () => {
    expect(focusOrder(["a", "b", "c"], 1, 3)).toEqual(["a", "b", "c"]);
    expect(focusOrder(["a", "b", "c"], 2, 2)).toEqual(["b", "c"]);
    expect(focusOrder(["a", "b", "c"], 4, 1)).toEqual(["a"]);
  });
});
