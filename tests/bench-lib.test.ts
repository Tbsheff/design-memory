import { describe, expect, test } from "bun:test";
import {
  buildPrompt, colorHistogram, compareModes, histogramDistance, parseJudgement, parseRunArgs, parseScoreArgs,
  readFlags, seededShuffleSides, selectTargets, ssimFromPixels, stats, summarize, viewportFor, winCounts,
} from "../bench/lib.ts";
import type { BuildScore, Mode, Target } from "../bench/lib.ts";
import { parseClaudeOutput } from "../bench/tools.ts";

const target: Target = { id: "t1", image: "targets/t1.jpg", source_url: "https://x.com/a/status/1", author: "a", prompt: "Build a dashboard.", width: 2048, height: 1536 };

const judgeJson = (overall: number) =>
  JSON.stringify(Object.fromEntries(["layout", "density", "typography", "color", "components", "detail", "overall"].map(k => [k, { score: k === "overall" ? overall : 3, reason: `${k} reason` }])));

const scored = (t: string, mode: Mode, overall: number, ssim = 0.5): BuildScore => ({ target: t, mode, sample: 1, ok: true, ssim, histogram_distance: 0.2, judge: parseJudgement(judgeJson(overall)) });

describe("run args", () => {
  test("defaults", () => {
    const o = parseRunArgs([]);
    expect(o).toMatchObject({ targets: null, modes: ["baseline", "taste", "reference"], samples: 1, model: "sonnet", concurrency: 3, out: null });
  });

  test("space and equals forms", () => {
    const o = parseRunArgs(["--targets", "a,b", "--modes=taste,baseline", "--samples", "2", "--model", "opus", "--concurrency=5", "--out", "x"]);
    expect(o).toMatchObject({ targets: ["a", "b"], modes: ["taste", "baseline"], samples: 2, model: "opus", concurrency: 5, out: "x" });
  });

  test("rejects bad input", () => {
    expect(() => parseRunArgs(["--modes", "taste,fancy"])).toThrow("unknown mode: fancy");
    expect(() => parseRunArgs(["--samples", "0"])).toThrow("positive");
    expect(() => parseRunArgs(["--samples", "1.5"])).toThrow("whole");
    expect(() => parseRunArgs(["--nope", "1"])).toThrow("unknown flag");
    expect(() => readFlags(["stray"])).toThrow("unexpected argument");
  });

  test("score args need a run and read force", () => {
    expect(() => parseScoreArgs([])).toThrow("--run");
    expect(parseScoreArgs(["--run", "r", "--force"])).toEqual({ run: "r", judgeModel: "opus", concurrency: 3, force: true });
  });

  test("selectTargets keeps order and rejects unknown ids", () => {
    const all = [target, { ...target, id: "t2" }];
    expect(selectTargets(all, null)).toHaveLength(2);
    expect(selectTargets(all, ["t2"]).map(t => t.id)).toEqual(["t2"]);
    expect(() => selectTargets(all, ["zz"])).toThrow("unknown target: zz");
  });
});

describe("prompts", () => {
  test("viewport keeps the target aspect at 1440 wide", () => {
    expect(viewportFor(target)).toEqual({ width: 1440, height: 1080 });
  });

  test("modes differ only by their extra line", () => {
    const base = buildPrompt(target, "baseline");
    expect(base).toContain("Build a dashboard.");
    expect(base).toContain("1440x1080");
    expect(base).not.toContain("taste");
    expect(buildPrompt(target, "taste")).toContain("taste-use skill");
    expect(buildPrompt(target, "reference")).toContain("Match this design as closely as you can: reference.jpg");
  });
});

describe("judge parsing", () => {
  test("accepts strict JSON and JSON inside prose or fences", () => {
    expect(parseJudgement(judgeJson(4)).overall).toEqual({ score: 4, reason: "overall reason" });
    expect(parseJudgement("Here:\n```json\n" + judgeJson(2) + "\n```").overall.score).toBe(2);
  });

  test("rejects missing fields, bad scores and empty reasons", () => {
    const j = JSON.parse(judgeJson(3)) as Record<string, { score: unknown; reason: unknown }>;
    expect(() => parseJudgement("no json here")).toThrow("no JSON");
    expect(() => parseJudgement(JSON.stringify({ ...j, color: undefined }))).toThrow("color is missing");
    expect(() => parseJudgement(JSON.stringify({ ...j, layout: { score: 11, reason: "x" } }))).toThrow("bad score");
    expect(() => parseJudgement(JSON.stringify({ ...j, layout: { score: 2.5, reason: "x" } }))).toThrow("bad score");
    expect(() => parseJudgement(JSON.stringify({ ...j, detail: { score: 3, reason: " " } }))).toThrow("no reason");
  });
});

describe("summary math", () => {
  test("stats gives mean, sample sd and range, ignoring NaN", () => {
    expect(stats([1, 2, 3, NaN])).toEqual({ n: 3, mean: 2, sd: 1, min: 1, max: 3 });
    expect(stats([5])).toEqual({ n: 1, mean: 5, sd: 0, min: 5, max: 5 });
    expect(stats([])).toBeNull();
  });

  test("compareModes and winCounts per target", () => {
    const scores = [scored("a", "taste", 4), scored("a", "baseline", 3), scored("b", "taste", 2), scored("b", "baseline", 2), scored("c", "baseline", 5)];
    expect(compareModes(scores, "a", "taste", "baseline")).toBe("a");
    expect(compareModes(scores, "b", "taste", "baseline")).toBe("tie");
    expect(compareModes(scores, "c", "taste", "baseline")).toBe("missing");
    expect(winCounts(scores, "taste", "baseline").counts).toEqual({ taste: 1, baseline: 0, tie: 1, missing: 1 });
  });

  test("summarize groups by mode and target and skips failed builds in metrics", () => {
    const failed: BuildScore = { target: "a", mode: "taste", sample: 2, ok: false, error: "x" };
    const scores = [scored("a", "taste", 4, 0.6), scored("a", "taste", 2, 0.4), failed, scored("a", "baseline", 3)];
    const metas = [{ target: "a", mode: "taste" as Mode, sample: 1, ok: true, cost_usd: 1.5, num_turns: 4 }, { target: "a", mode: "taste" as Mode, sample: 2, ok: false, cost_usd: 0.5 }];
    const s = summarize(scores, metas) as { by_mode: Record<string, { builds: number; failed: number; metrics: Record<string, { mean: number; sd: number } | null>; build: { cost_usd: number; ok: number } }>; by_target: Record<string, Record<string, unknown>> };
    expect(s.by_mode.taste!.builds).toBe(3);
    expect(s.by_mode.taste!.failed).toBe(1);
    expect(s.by_mode.taste!.metrics.overall).toMatchObject({ mean: 3, sd: 1.4142 });
    expect(s.by_mode.taste!.metrics.ssim!.mean).toBe(0.5);
    expect(s.by_mode.taste!.build).toMatchObject({ cost_usd: 2, ok: 1 });
    expect(Object.keys(s.by_target.a!).sort()).toEqual(["baseline", "taste"]);
  });
});

describe("pixel metrics", () => {
  const w = 16, h = 16;
  const ramp = Uint8Array.from({ length: w * h }, (_, i) => (i * 7) % 256);

  test("ssim is 1 for identical images and lower for different ones", () => {
    expect(ssimFromPixels(ramp, ramp, w, h)).toBe(1);
    const flat = new Uint8Array(w * h).fill(128);
    expect(ssimFromPixels(ramp, flat, w, h)).toBeLessThan(0.5);
    expect(() => ssimFromPixels(ramp, flat.slice(1), w, h)).toThrow();
  });

  test("histogram distance is 0 for same colors and 1 for disjoint colors", () => {
    const black = new Uint8Array(30);
    const white = new Uint8Array(30).fill(255);
    expect(histogramDistance(colorHistogram(black), colorHistogram(black))).toBe(0);
    expect(histogramDistance(colorHistogram(black), colorHistogram(white))).toBe(1);
  });

  test("seeded sides are stable for a seed", () => {
    const keys = ["a", "b", "c", "d", "e", "f"];
    expect(seededShuffleSides(keys, 42)).toEqual(seededShuffleSides(keys, 42));
  });
});

describe("claude output parsing", () => {
  test("reads the result and tool uses from a verbose message array", () => {
    const out = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Skill", input: { skill: "bench-taste:taste-use" } }, { type: "tool_use", id: "u2", name: "Bash", input: { command: "ls ~" } }, { type: "text", text: "hi" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "loaded" }] }, { type: "tool_result", tool_use_id: "u2", is_error: true, content: "denied" }] } },
      { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.12, duration_ms: 900, num_turns: 3 },
    ]);
    const r = parseClaudeOutput(out);
    expect(r).toMatchObject({ ok: true, text: "done", cost_usd: 0.12, num_turns: 3 });
    expect(r.tool_uses).toEqual([
      { name: "Skill", input: { skill: "bench-taste:taste-use" }, ok: true, result_head: "loaded" },
      { name: "Bash", input: { command: "ls ~" }, ok: false, result_head: "denied" },
    ]);
  });

  test("reads a single result object and reports errors", () => {
    expect(parseClaudeOutput(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "" })).ok).toBe(false);
    expect(parseClaudeOutput("not json").error).toContain("unparseable");
    expect(parseClaudeOutput("[]").error).toBe("no result message");
  });
});
