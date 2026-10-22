import { extractJsonObject, JUDGE_SCALE, round, RULE_VERDICTS } from "./lib.ts";
import type { BuildScore, Judgement, RuleResult, RuleSummary, RuleVerdict, Split, Target } from "./lib.ts";

export const OVERALL_WEIGHT = 0.7;
export const RULE_WEIGHT = 0.3;
export const HTML_LIMIT = 40_000;

export function splitTargets(targets: Target[], split: Split): Target[] {
  return targets.filter(t => t.split === split);
}

export function parseProfileRules(profile: string): string[] {
  const rules: string[] = [];
  for (const line of profile.split("\n")) {
    const m = line.match(/^- \*\*(Prefer|Avoid):\*\*\s+(.*)$/);
    if (!m) continue;
    const text = m[2]!.replace(/\s+_\(source:.*\)_\s*$/, "").trim();
    if (text) rules.push(`${m[1]}: ${text}`);
  }
  return rules;
}

export function prepareHtml(html: string, limit = HTML_LIMIT): string {
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1")
    .replace(/\n\s*\n+/g, "\n");
  const blocks = (tag: string) => clean.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi")) ?? [];
  const styles = blocks("style");
  const scripts = blocks("script");
  let rest = clean;
  for (const b of [...styles, ...scripts]) rest = rest.replace(b, "");
  const ordered = [...styles, rest.trim(), ...scripts].join("\n");
  return ordered.length > limit ? `${ordered.slice(0, limit)}\n[... truncated ${ordered.length - limit} characters]` : ordered;
}

export function ruleJudgePrompt(rules: string[], html: string): string {
  const list = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  return `You check one UI build against a list of design rules. The rendered page is 2-build.png in the current directory. Read it first. Its HTML source follows below, with comments removed and possibly truncated.

For each rule, decide one verdict:
- "meets": the screenshot or the code shows the rule is followed.
- "misses": the page has things the rule applies to, and they break it.
- "n-a": the page has nothing the rule can apply to.

Judge what the page does, not what it claims. Rules about motion, hover, press or wrapping can be checked in the CSS. A rule that applies but that you cannot confirm counts as "misses".

Rules:
${list}

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape, with one entry per rule in order:
{"rules":[{"id":1,"verdict":"meets","reason":"one line"}]}

HTML source:
${html}`;
}

function verdictOf(value: unknown, id: number): RuleVerdict {
  const v = String(value ?? "").toLowerCase().replace(/^na$|^n\/a$/, "n-a");
  if (!(RULE_VERDICTS as readonly string[]).includes(v)) throw new Error(`rule ${id} has bad verdict: ${String(value)}`);
  return v as RuleVerdict;
}

export function rulePass(meets: number, misses: number): number | null {
  return meets + misses ? round(meets / (meets + misses)) : null;
}

export function summarizeRules(results: RuleResult[]): RuleSummary {
  const count = (v: RuleVerdict) => results.filter(r => r.verdict === v).length;
  const meets = count("meets");
  const misses = count("misses");
  return { results, meets, misses, na: count("n-a"), rule_pass: rulePass(meets, misses) };
}

export function parseRuleJudgement(text: string, rules: string[]): RuleSummary {
  const raw = extractJsonObject(text) as { rules?: { id?: unknown; verdict?: unknown; reason?: unknown }[] };
  if (!Array.isArray(raw.rules)) throw new Error("rule judge reply has no rules array");
  const byId = new Map(raw.rules.map(r => [Number(r.id), r]));
  const results = rules.map((rule, i) => {
    const entry = byId.get(i + 1);
    if (!entry) throw new Error(`rule ${i + 1} is missing`);
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (!reason) throw new Error(`rule ${i + 1} has no reason`);
    return { rule, verdict: verdictOf(entry.verdict, i + 1), reason };
  });
  return summarizeRules(results);
}

export function objective(overall: number, rule: number | null): number {
  const look = overall / JUDGE_SCALE;
  return round(rule === null ? look : OVERALL_WEIGHT * look + RULE_WEIGHT * rule);
}

export function buildObjective(ok: boolean, judge: Judgement | undefined, rules: RuleSummary | undefined): number | null {
  if (!ok) return 0;
  if (!judge) return null;
  return objective(judge.overall.score, rules?.rule_pass ?? null);
}

export type MeanSe = { n: number; mean: number; se: number };

export function meanSe(values: number[]): MeanSe {
  const xs = values.filter(v => Number.isFinite(v));
  if (!xs.length) return { n: 0, mean: NaN, se: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { n: xs.length, mean: round(mean), se: round(sd / Math.sqrt(xs.length)) };
}

export type Scored = Pick<BuildScore, "target" | "objective">;

export function evalScore(scores: Scored[]): MeanSe {
  return meanSe(scores.map(s => s.objective ?? NaN));
}

export type ArmScore = { score: MeanSe; overall: MeanSe; rule_pass: MeanSe };

export function armSummary(scores: BuildScore[]): ArmScore {
  const mean = (f: (s: BuildScore) => number | null | undefined) => evalScore(scores.map(s => ({ target: s.target, objective: f(s) ?? null })));
  return { score: evalScore(scores), overall: mean(s => s.judge?.overall.score), rule_pass: mean(s => s.rules?.rule_pass) };
}

export function worstBuilds<T extends Scored>(scores: T[], count: number): T[] {
  return scores.filter(s => s.objective !== null && s.objective !== undefined).sort((x, y) => x.objective! - y.objective!).slice(0, count);
}

export type LintInput = { skill: string; files: Record<string, string>; banned: string[]; maxSkillLines: number };

function bannedHits(text: string, banned: string[]): string[] {
  const lower = text.toLowerCase();
  return banned.filter(b => b.length > 2 && lower.includes(b.toLowerCase()));
}

function brokenLinks(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
    for (const m of text.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
      const target = normalize(dir + m[1]!);
      if (!(target in files) && !EXTERNAL_REFS.has(target)) out.push(`${name} -> ${m[1]}`);
    }
  }
  return out;
}

const EXTERNAL_REFS = new Set(["references/taste-interview.md", "references/analysis.md"]);

function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
}

export function lintCandidate(input: LintInput): string[] {
  const problems: string[] = [];
  if (!/^---\n[\s\S]*?\bname:\s*taste-use\b[\s\S]*?\n---\n/.test(input.skill)) problems.push("SKILL.md frontmatter must keep name: taste-use");
  const lines = input.skill.split("\n").length;
  if (lines > input.maxSkillLines) problems.push(`SKILL.md has ${lines} lines (max ${input.maxSkillLines})`);
  const all = { "SKILL.md": input.skill, ...input.files };
  for (const [name, text] of Object.entries(all)) {
    const hits = bannedHits(text, input.banned);
    if (hits.length) problems.push(`${name} names benchmark-specific words: ${hits.join(", ")}`);
    if (/#[0-9a-f]{6}\b/i.test(text)) problems.push(`${name} has a hex color`);
  }
  for (const link of brokenLinks(all)) problems.push(`broken link: ${link}`);
  return problems;
}
