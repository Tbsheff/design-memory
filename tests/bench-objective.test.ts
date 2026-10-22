import { describe, expect, test } from "bun:test";
import { parseJudgement, parseRunArgs } from "../bench/lib.ts";
import type { BuildScore, Target } from "../bench/lib.ts";
import {
  armSummary, buildObjective, evalScore, lintCandidate, meanSe, objective, parseProfileRules, parseRuleJudgement, prepareHtml,
  rulePass, splitTargets, worstBuilds,
} from "../bench/objective.ts";
import { comparisons, parseOptimizeArgs, roundFocuses } from "../bench/optimize.ts";

const t = (id: string, split?: "train" | "holdout"): Target => ({ id, image: "", source_url: "", author: "a", prompt: "", width: 1, height: 1, split });

describe("split filter", () => {
  test("keeps only the asked split and drops unsplit targets", () => {
    const all = [t("a", "train"), t("b", "holdout"), t("c"), t("d", "train")];
    expect(splitTargets(all, "train").map(x => x.id)).toEqual(["a", "d"]);
    expect(splitTargets(all, "holdout").map(x => x.id)).toEqual(["b"]);
  });

  test("the real targets have 5 train and 3 holdout", async () => {
    const targets = (await Bun.file(new URL("../bench/targets.json", import.meta.url)).json()) as Target[];
    expect(splitTargets(targets, "train")).toHaveLength(5);
    expect(splitTargets(targets, "holdout")).toHaveLength(3);
  });
});

describe("objective math", () => {
  test("weights overall and rule pass", () => {
    expect(objective(10, 1)).toBe(1);
    expect(objective(5, 0.5)).toBe(0.5);
    expect(objective(6, 0.8)).toBe(0.66);
  });

  test("no applicable rules uses the look score alone", () => {
    expect(rulePass(0, 0)).toBeNull();
    expect(objective(7, null)).toBe(0.7);
    expect(rulePass(3, 1)).toBe(0.75);
  });

  test("a failed build scores 0 and a judge failure is left out", () => {
    expect(buildObjective(false, undefined, undefined)).toBe(0);
    expect(buildObjective(true, undefined, undefined)).toBeNull();
  });

  test("mean and standard error", () => {
    expect(meanSe([0.5])).toEqual({ n: 1, mean: 0.5, se: 0 });
    const m = meanSe([0.4, 0.6]);
    expect(m.mean).toBe(0.5);
    expect(m.se).toBeCloseTo(0.1, 4);
    expect(meanSe([]).n).toBe(0);
    expect(evalScore([{ target: "a", objective: 0.2 }, { target: "a", objective: null }]).n).toBe(1);
  });

  test("worst builds skip unscored ones", () => {
    const s = [{ target: "a", objective: 0.5 }, { target: "b", objective: null }, { target: "c", objective: 0.1 }];
    expect(worstBuilds(s, 2).map(x => x.target)).toEqual(["c", "a"]);
  });
});

describe("arm summary", () => {
  test("means the objective, overall and rule pass", () => {
    const b = (overall: number, rule: number | null, objective: number) => ({ target: "a", mode: "taste", sample: 1, ok: true, objective, judge: { overall: { score: overall } }, rules: { rule_pass: rule } }) as unknown as BuildScore;
    const a = armSummary([b(6, 0.8, 0.66), b(4, null, 0.4)]);
    expect(a.score.mean).toBeCloseTo(0.53, 4);
    expect(a.overall.mean).toBe(5);
    expect(a.rule_pass.n).toBe(1);
  });
});

describe("rule judge", () => {
  const rules = ["Prefer: a", "Avoid: b", "Prefer: c"];
  const reply = (entries: unknown[]) => `Sure:\n\`\`\`json\n${JSON.stringify({ rules: entries })}\n\`\`\``;

  test("parses verdicts and computes the pass rate", () => {
    const r = parseRuleJudgement(reply([{ id: 1, verdict: "meets", reason: "x" }, { id: 2, verdict: "misses", reason: "y" }, { id: 3, verdict: "N/A", reason: "z" }]), rules);
    expect(r).toMatchObject({ meets: 1, misses: 1, na: 1, rule_pass: 0.5 });
    expect(r.results[1]).toEqual({ rule: "Avoid: b", verdict: "misses", reason: "y" });
  });

  test("all n-a gives a null pass rate", () => {
    const r = parseRuleJudgement(reply(rules.map((_, i) => ({ id: i + 1, verdict: "n-a", reason: "none" }))), rules);
    expect(r.rule_pass).toBeNull();
  });

  test("rejects missing rules, bad verdicts and empty reasons", () => {
    expect(() => parseRuleJudgement(reply([{ id: 1, verdict: "meets", reason: "x" }]), rules)).toThrow("rule 2 is missing");
    expect(() => parseRuleJudgement(reply(rules.map((_, i) => ({ id: i + 1, verdict: "maybe", reason: "x" }))), rules)).toThrow("bad verdict");
    expect(() => parseRuleJudgement(reply(rules.map((_, i) => ({ id: i + 1, verdict: "meets", reason: " " }))), rules)).toThrow("no reason");
    expect(() => parseRuleJudgement("{}", rules)).toThrow("no rules array");
  });

  test("reads rules from the profile text and drops sources", () => {
    const profile = "# Design Memory profile\n\n### Feel\n\n- **Prefer:** One accent  _(source: direct statement: x; pref_1)_\n- **Avoid:** Template look  _(source: y)_\n- not a rule\n";
    expect(parseProfileRules(profile)).toEqual(["Prefer: One accent", "Avoid: Template look"]);
  });

  test("html prep strips comments, puts styles first and truncates", () => {
    const html = `<html><body><!-- rule: shadows --><div>hi</div><script>// meets rule\nlet a = "https://x.y";</script><style>/* note */ .a{color:red}</style></body></html>`;
    const out = prepareHtml(html);
    expect(out).not.toContain("rule");
    expect(out).not.toContain("note");
    expect(out).toContain("https://x.y");
    expect(out.indexOf("<style>")).toBeLessThan(out.indexOf("<div>"));
    expect(out.indexOf("<div>")).toBeLessThan(out.indexOf("<script>"));
    expect(prepareHtml("x".repeat(50), 10)).toContain("truncated 40 characters");
  });
});

describe("judge scale", () => {
  test("accepts 0 and 10", () => {
    const j = (n: number) => JSON.stringify(Object.fromEntries(["layout", "density", "typography", "color", "components", "detail", "overall"].map(k => [k, { score: n, reason: "r" }])));
    expect(parseJudgement(j(0)).overall.score).toBe(0);
    expect(parseJudgement(j(10)).overall.score).toBe(10);
  });
});

describe("candidate lint", () => {
  const skill = "---\nname: taste-use\ndescription: x\n---\n\nRead [a](references/study-a-reference.md).\n";
  const files = { "references/study-a-reference.md": "See [aspects](aspects.md).", "references/aspects.md": "ok" };

  test("a clean candidate passes", () => {
    expect(lintCandidate({ skill, files, banned: ["Stripe"], maxSkillLines: 90 })).toEqual([]);
  });

  test("flags frontmatter, length, banned words, hex colors and broken links", () => {
    const problems = lintCandidate({
      skill: `${"line\n".repeat(100)}see stripe and #12ab9f and [x](references/nope.md)`,
      files, banned: ["Stripe"], maxSkillLines: 90,
    });
    expect(problems.join("\n")).toContain("frontmatter");
    expect(problems.join("\n")).toContain("lines (max 90)");
    expect(problems.join("\n")).toContain("Stripe");
    expect(problems.join("\n")).toContain("hex color");
    expect(problems.join("\n")).toContain("broken link: SKILL.md -> references/nope.md");
  });
});

describe("round focuses", () => {
  test("a seeded focus leads its round and the rotation fills the rest", () => {
    expect(roundFocuses({ seedFocus: { round: 5, focus: "minimal" } }, 5, 3).map(f => f.id)).toEqual(["minimal", "process", "rules"]);
    expect(roundFocuses({ seedFocus: { round: 5, focus: "minimal" } }, 6, 3).map(f => f.id)).toEqual(["rules", "craft", "process"]);
    expect(roundFocuses({ seedFocus: null }, 1, 2).map(f => f.id)).toEqual(["craft", "process"]);
  });
});

describe("args", () => {
  test("run accepts --skill-dir", () => {
    expect(parseRunArgs(["--skill-dir", "x"]).skillDir).toBe("x");
    expect(parseRunArgs([]).skillDir).toBeNull();
  });

  test("optimize defaults and overrides", () => {
    expect(parseOptimizeArgs([])).toMatchObject({ rounds: 5, samples: 2, budgetUsd: 60, holdoutSamples: 3, candidates: 3, trainTargets: null, accept: { on: "closer", minWinRate: 0.6, maxP: 0.2, minGuardRate: 0.4, guardLossP: 0.2 } });
    expect(parseOptimizeArgs(["--rounds", "1", "--samples", "1", "--candidates", "2", "--train-targets", "a,b", "--accept-on", "rules", "--max-p", "0.1"])).toMatchObject({ rounds: 1, candidates: 2, trainTargets: ["a", "b"], accept: { on: "rules", maxP: 0.1 } });
    expect(() => parseOptimizeArgs(["--bogus", "1"])).toThrow("unknown flag");
    expect(() => parseOptimizeArgs(["--candidates", "4"])).toThrow("at most 3");
    expect(() => parseOptimizeArgs(["--accept-on", "vibes"])).toThrow("--accept-on");
    expect(parseOptimizeArgs(["--guard-loss-p", "0.1", "--seed-from", "bench/optimize/full-2"])).toMatchObject({ accept: { guardLossP: 0.1 }, seedFrom: "bench/optimize/full-2" });
    expect(parseOptimizeArgs([]).seedFrom).toBeNull();
    expect(parseOptimizeArgs(["--accept-on", "rules"]).accept.guards).toEqual(["closer", "calmer"]);
    expect(parseOptimizeArgs(["--accept-on", "rules", "--guards", "calmer"]).accept.guards).toEqual(["calmer"]);
    expect(() => parseOptimizeArgs(["--accept-on", "rules", "--guards", "rules"])).toThrow("--guards");
    expect(parseOptimizeArgs(["--seed-focus", "minimal"]).seedFocus).toEqual({ round: 1, focus: "minimal" });
    expect(() => parseOptimizeArgs(["--seed-focus", "vibes"])).toThrow("unknown focus");
  });
});

describe("holdout comparisons", () => {
  const arm = (name: string) => ({ name, ref: { out: `/o/${name}`, mode: "taste" }, scores: [] });
  test("extra arms meet original, baseline and best", () => {
    const list = comparisons([arm("baseline"), arm("original"), arm("best")], [arm("minimal")], true);
    expect(list.map(([n, a, b]) => [n, a.name, b.name])).toEqual([
      ["best_vs_baseline", "baseline", "best"], ["best_vs_original", "original", "best"],
      ["minimal_vs_original", "original", "minimal"], ["minimal_vs_baseline", "baseline", "minimal"], ["minimal_vs_best", "best", "minimal"],
    ]);
    expect(comparisons([arm("baseline"), arm("original"), arm("original")], [], false).map(c => c[0])).toEqual(["best_vs_baseline"]);
  });
});
