export const MODES = ["baseline", "taste", "reference"] as const;
export type Mode = (typeof MODES)[number];
export const DIMENSIONS = ["layout", "density", "typography", "color", "components", "detail", "overall"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Judgement = Record<Dimension, { score: number; reason: string }>;

export type Target = { id: string; image: string; source_url: string; author: string; prompt: string; width: number; height: number };

export type RunOptions = {
  targets: string[] | null;
  modes: Mode[];
  samples: number;
  model: string;
  concurrency: number;
  out: string | null;
  timeoutMinutes: number;
  budgetUsd: number;
};

export type ScoreOptions = { run: string; judgeModel: string; concurrency: number; force: boolean };

export type BuildScore = {
  target: string;
  mode: Mode;
  sample: number;
  ok: boolean;
  error?: string;
  ssim?: number;
  histogram_distance?: number;
  judge?: Judgement;
  judge_cost_usd?: number;
};

export const VIEWPORT_WIDTH = 1440;

export function viewportFor(target: Pick<Target, "width" | "height">) {
  return { width: VIEWPORT_WIDTH, height: Math.round((VIEWPORT_WIDTH * target.height) / target.width) };
}

export function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    const isValue = next !== undefined && !next.startsWith("--");
    flags.set(arg.slice(2), isValue ? next : "true");
    if (isValue) i++;
  }
  return flags;
}

function list(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const items = value.split(",").map(s => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const n = positive(value, fallback, name);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be a whole number`);
  return n;
}

export function parseModes(value: string | undefined): Mode[] {
  const items = list(value) ?? [...MODES];
  const bad = items.filter(m => !(MODES as readonly string[]).includes(m));
  if (bad.length) throw new Error(`unknown mode: ${bad.join(", ")} (use ${MODES.join(", ")})`);
  return [...new Set(items)] as Mode[];
}

const RUN_FLAGS = new Set(["targets", "modes", "samples", "model", "concurrency", "out", "timeout-minutes", "budget-usd"]);

function rejectUnknown(flags: Map<string, string>, known: Set<string>) {
  const unknown = [...flags.keys()].filter(k => !known.has(k));
  if (unknown.length) throw new Error(`unknown flag: --${unknown.join(", --")}`);
}

export function parseRunArgs(argv: string[]): RunOptions {
  const flags = readFlags(argv);
  rejectUnknown(flags, RUN_FLAGS);
  return {
    targets: list(flags.get("targets")),
    modes: parseModes(flags.get("modes")),
    samples: positiveInt(flags.get("samples"), 1, "samples"),
    model: flags.get("model") ?? "sonnet",
    concurrency: positiveInt(flags.get("concurrency"), 3, "concurrency"),
    out: flags.get("out") ?? null,
    timeoutMinutes: positive(flags.get("timeout-minutes"), 20, "timeout-minutes"),
    budgetUsd: positive(flags.get("budget-usd"), 5, "budget-usd"),
  };
}

const SCORE_FLAGS = new Set(["run", "judge-model", "concurrency", "force"]);

export function parseScoreArgs(argv: string[]): ScoreOptions {
  const flags = readFlags(argv);
  rejectUnknown(flags, SCORE_FLAGS);
  const run = flags.get("run");
  if (!run || run === "true") throw new Error("--run <dir> is required");
  return {
    run,
    judgeModel: flags.get("judge-model") ?? "opus",
    concurrency: positiveInt(flags.get("concurrency"), 3, "concurrency"),
    force: flags.get("force") === "true",
  };
}

export function selectTargets(all: Target[], ids: string[] | null): Target[] {
  if (!ids) return all;
  const missing = ids.filter(id => !all.some(t => t.id === id));
  if (missing.length) throw new Error(`unknown target: ${missing.join(", ")}`);
  return all.filter(t => ids.includes(t.id));
}

export function timestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, "").replaceAll(":", "-").replace("T", "_");
}

export const OUTPUT_RULES =
  "Write the whole UI as one self-contained file named index.html in the current directory: inline CSS and JS, no build step. CDN links for web fonts or Tailwind are fine. Use realistic sample data. Do not ask questions; make reasonable choices and finish.";

export function buildPrompt(target: Target, mode: Mode, referenceFile = "reference.jpg"): string {
  const { width, height } = viewportFor(target);
  const view = `It will be shown in a desktop browser at ${width}x${height}.`;
  const extra: Record<Mode, string> = {
    baseline: "",
    taste: "Use my saved design taste (taste-use skill) for this.",
    reference: `Match this design as closely as you can: ${referenceFile}`,
  };
  return [target.prompt, extra[mode], view, OUTPUT_RULES].filter(Boolean).join("\n\n");
}

export const JUDGE_PROMPT = `You compare a UI build against a target design. Two images are in the current directory:
- 1-target.jpg is the TARGET design (the answer key).
- 2-build.png is the BUILD, a web page made from a short text prompt.

Read 1-target.jpg first, then 2-build.png. Ignore any gray backdrop, device frame or drop shadow around the target; compare the app screen itself. Do not reward or punish the exact sample text or numbers; judge the visual design.

Score each field from 1 to 5 (integers only):
- layout: regions, their placement, proportions and alignment.
- density: amount of content per area, spacing and whitespace rhythm.
- typography: type families, sizes, weights, hierarchy, numeric styling.
- color: theme (light/dark), palette, accent use, contrast, surfaces.
- components: the same kinds of controls and widgets (cards, charts, tables, chips, tabs) styled the same way.
- detail: borders, radius, shadows, icons, dividers, small finishing touches.
- overall: how close the build looks to the target as a whole.

Scale for every field:
5 = indistinguishable from the target at a glance.
4 = clearly the same design; small differences only on close look.
3 = same kind of screen and structure, but visibly different styling or proportions.
2 = same product idea, but a different design.
1 = a different product or a broken or empty page.

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape:
{"layout":{"score":3,"reason":"one line"},"density":{"score":3,"reason":"one line"},"typography":{"score":3,"reason":"one line"},"color":{"score":3,"reason":"one line"},"components":{"score":3,"reason":"one line"},"detail":{"score":3,"reason":"one line"},"overall":{"score":3,"reason":"one line"}}`;

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in judge reply");
  return JSON.parse(text.slice(start, end + 1));
}

function validField(name: string, value: unknown): { score: number; reason: string } {
  const field = value as { score?: unknown; reason?: unknown } | null;
  if (!field || typeof field !== "object") throw new Error(`judge field ${name} is missing`);
  const score = field.score;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) throw new Error(`judge field ${name} has bad score: ${String(score)}`);
  if (typeof field.reason !== "string" || !field.reason.trim()) throw new Error(`judge field ${name} has no reason`);
  return { score, reason: field.reason.trim() };
}

export function parseJudgement(text: string): Judgement {
  const raw = extractJsonObject(text) as Record<string, unknown>;
  const out = {} as Judgement;
  for (const dim of DIMENSIONS) out[dim] = validField(dim, raw[dim]);
  return out;
}

export type Stats = { n: number; mean: number; sd: number; min: number; max: number };

export function stats(values: number[]): Stats | null {
  const xs = values.filter(v => Number.isFinite(v));
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { n: xs.length, mean: round(mean), sd: round(Math.sqrt(variance)), min: Math.min(...xs), max: Math.max(...xs) };
}

export function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

type Metric = "ssim" | "histogram_distance" | Dimension;

function metricValue(score: BuildScore, metric: Metric): number {
  if (metric === "ssim") return score.ssim ?? NaN;
  if (metric === "histogram_distance") return score.histogram_distance ?? NaN;
  return score.judge?.[metric].score ?? NaN;
}

const METRICS: Metric[] = ["ssim", "histogram_distance", ...DIMENSIONS];

function metricStats(scores: BuildScore[]) {
  const ok = scores.filter(s => s.ok);
  const out: Record<string, Stats | null> = {};
  for (const m of METRICS) out[m] = stats(ok.map(s => metricValue(s, m)));
  return { builds: scores.length, failed: scores.length - ok.length, metrics: out };
}

export type Winner = "a" | "b" | "tie" | "missing";

export function compareModes(scores: BuildScore[], target: string, a: Mode, b: Mode): Winner {
  const mean = (mode: Mode) => stats(scores.filter(s => s.ok && s.target === target && s.mode === mode).map(s => metricValue(s, "overall")))?.mean;
  const ma = mean(a);
  const mb = mean(b);
  if (ma === undefined || mb === undefined) return "missing";
  if (ma === mb) return "tie";
  return ma > mb ? "a" : "b";
}

export function winCounts(scores: BuildScore[], a: Mode, b: Mode) {
  const targets = [...new Set(scores.map(s => s.target))];
  const counts = { [a]: 0, [b]: 0, tie: 0, missing: 0 } as Record<string, number>;
  const perTarget: Record<string, string> = {};
  for (const t of targets) {
    const w = compareModes(scores, t, a, b);
    const label = w === "a" ? a : w === "b" ? b : w;
    counts[label] = (counts[label] ?? 0) + 1;
    perTarget[t] = label;
  }
  return { pair: `${a} vs ${b}`, counts, per_target: perTarget };
}

export type BuildMeta = { target: string; mode: Mode; sample: number; ok: boolean; cost_usd?: number; duration_ms?: number; num_turns?: number };

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

function costStats(metas: BuildMeta[]) {
  const sum = (f: (m: BuildMeta) => number | undefined) => round(metas.reduce((a, m) => a + (f(m) ?? 0), 0));
  return { builds: metas.length, ok: metas.filter(m => m.ok).length, cost_usd: sum(m => m.cost_usd), duration_ms: sum(m => m.duration_ms), turns: stats(metas.map(m => m.num_turns ?? NaN)) };
}

export function summarize(scores: BuildScore[], metas: BuildMeta[]) {
  const byMode: Record<string, unknown> = {};
  for (const [mode, group] of groupBy(scores, s => s.mode)) byMode[mode] = { ...metricStats(group), build: costStats(metas.filter(m => m.mode === mode)) };
  const byTarget: Record<string, Record<string, unknown>> = {};
  for (const [key, group] of groupBy(scores, s => `${s.target}\u0000${s.mode}`)) {
    const [target, mode] = key.split("\u0000") as [string, string];
    byTarget[target] = { ...byTarget[target], [mode]: metricStats(group) };
  }
  const wins = [winCounts(scores, "taste", "baseline"), winCounts(scores, "reference", "baseline"), winCounts(scores, "reference", "taste")];
  return { by_mode: byMode, by_target: byTarget, wins };
}

export function ssimFromPixels(a: Uint8Array, b: Uint8Array, width: number, height: number, window = 8, step = 4): number {
  if (a.length !== width * height || b.length !== a.length) throw new Error("pixel buffers must match width*height");
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let count = 0;
  for (let y = 0; y + window <= height; y += step) {
    for (let x = 0; x + window <= width; x += step) {
      total += windowSsim(a, b, width, x, y, window, c1, c2);
      count++;
    }
  }
  return count ? round(total / count) : NaN;
}

function windowSsim(a: Uint8Array, b: Uint8Array, width: number, x0: number, y0: number, size: number, c1: number, c2: number): number {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const va = a[y * width + x]!;
      const vb = b[y * width + x]!;
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
  }
  const n = size * size;
  const ma = sa / n, mb = sb / n;
  const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
  return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
}

export function colorHistogram(rgb: Uint8Array, bins = 8): Float64Array {
  const hist = new Float64Array(bins ** 3);
  const shift = 256 / bins;
  const pixels = Math.floor(rgb.length / 3);
  for (let i = 0; i < pixels; i++) {
    const r = Math.floor(rgb[i * 3]! / shift), g = Math.floor(rgb[i * 3 + 1]! / shift), b = Math.floor(rgb[i * 3 + 2]! / shift);
    hist[(r * bins + g) * bins + b]! += 1;
  }
  if (pixels) for (let i = 0; i < hist.length; i++) hist[i]! /= pixels;
  return hist;
}

export function histogramDistance(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) throw new Error("histograms must have the same bins");
  let overlap = 0;
  for (let i = 0; i < a.length; i++) overlap += Math.min(a[i]!, b[i]!);
  return round(1 - overlap);
}

export function seededShuffleSides(keys: string[], seed: number): Record<string, boolean> {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = next() < 0.5;
  return out;
}
