import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIMENSIONS } from "./lib.ts";
import type { BuildScore } from "./lib.ts";
import { evalScore, worstBuilds } from "./objective.ts";
import { loadTargets } from "./run.ts";
import { run } from "./tools.ts";

export type Focus = { id: string; title: string; text: string };

export const FOCUSES: Focus[] = [
  {
    id: "craft", title: "design craft",
    text: `Your focus is DESIGN CRAFT. Short prompts often produce thin, toy-like screens. Write general guidance that makes a builder turn a short prompt into a credible, dense, professional product screen: realistic data volume (enough rows, items, history and labels to fill the view), a complete app shell (navigation, header, page title, actions), high information density with clear hierarchy, a small and consistent type scale, restrained color with one accent, one consistent spacing scale, and real component states (selected, hover, empty, status). Keep it general; it must fit any product.`,
  },
  {
    id: "process", title: "process",
    text: `Your focus is PROCESS. Fix the order of steps and what the builder decides before it writes code: read the profile, then plan the layout and the content (regions, components, data volume, type scale, spacing, color roles), then build, then check, then fix. Say what to write down in the plan before code. Say how to check the page when no browser is available: read the HTML and CSS back against the plan and the rules, look for empty areas, missing states, broken alignment and values that drift from the scale, then fix them.`,
  },
  {
    id: "rules", title: "rule application",
    text: `Your focus is RULE APPLICATION. Builders often follow a rule in one place and forget it elsewhere. Write guidance that turns each profile rule into concrete CSS decisions (tokens, variables, selectors, component patterns) before the build, so each rule applies everywhere it can, and a short final check that walks every rule against the CSS and the markup. Do not copy any rule text into the skill; teach the method.`,
  },
];

export const MINIMAL_FOCUS: Focus = {
  id: "minimal", title: "minimal first",
  text: `Your focus is MINIMAL FIRST, a process change. Make the builder work in this order:
1. Build the smallest screen that does the job: the app shell, the page title, the one primary view, and the one to three numbers or columns the task needs.
2. Then add data, columns, filters and badges one at a time, and only when each one earns its place for the task.
3. Stop before the screen gets busy.
Before any code, the builder writes its plan, and the plan lists each extra element it considered with an add or skip decision and a short reason. Put this where the builder will follow it on every build, and keep the rest of the skill intact.`,
};

export function focusById(id: string): Focus {
  const f = [...FOCUSES, MINIMAL_FOCUS].find(x => x.id === id);
  if (!f) throw new Error(`unknown focus: ${id}`);
  return f;
}

export function proposerPrompt(focus: Focus): string {
  return `You improve a skill for a coding agent. The skill is "taste-use". It tells an agent how to build or review a user interface with the user's saved design taste: a profile of confirmed rules, plus a library of saved reference designs (screenshots) that the user collected.

The skill files are in ./skill/ (SKILL.md and references/*.md). Edit them in place. Do not create other files.

How we test the skill:
- A builder agent gets a short product prompt (for example "build a dark usage dashboard with a KPI row and a table") plus "Use my saved design taste (taste-use skill) for this."
- The builder runs headless. It has Read, Write, Edit, the Skill tool, and Bash limited to the taste CLI read commands (profile, brief, show, list, search). It writes one index.html. It cannot run a browser, so it cannot see its own page.
- The page is rendered and compared with a target design. The targets come from designers the user follows, so they stand in for the user's taste. The builder never sees the target.
- Your version and the current skill each build every case. A blind judge sees the target and the two builds side by side and says which one is closer to the target and which one follows the profile rules better. Your version must win clearly on one question and must not lose clearly on the other to replace the current skill.

What to change: the skill text itself. The profile and the library are fixed. Do not tell the builder to change the taste data, and do not add a visual system or design tokens to the profile. Saved reference images are a small extra, not the main lever.

Lessons from earlier runs:
- Strict rule application made builds sparse and open, and they lost closeness. A real product screen needs structure and the content the task asks for. Read a rule such as "hierarchy over boxes" as "fewer nested containers", not as "an empty layout".
- Then a version won closeness mostly by adding rows, columns and badges, and the user said: "the agent tends to make the interface too busy". The user also said: "start minimal and add data incrementally".
- So the goal is a calm, focused screen: it applies the rules, it shows what the task needs, and it is dense only where the task needs density. It is not filled with extras. Each extra element (column, badge, filter, chart, accent) must earn its place.
- A blind judge now also asks which build is calmer and less busy. Your version must win on the rules and must not lose on closeness or on calm.

${focus.text}

Do this:
1. Read ./feedback/feedback.md. Then look at the side-by-side images in ./feedback/ (left = target, right = build).
2. Find the 1 to 3 changes in your focus that are most likely to make builds look closer to the targets and follow the profile rules better.
3. Edit the skill files.
4. Reply with a short list of your changes and the reason for each.

Constraints:
- Guidance must be general. It must help any user with any taste library and any project. Never name a product, brand, company, person, number, color value, or specific layout that you saw in the feedback or the images.
- Do not copy the profile rules into the skill. The builder loads them from the CLI.
- Keep SKILL.md under about 90 lines, and keep its frontmatter. Keep each reference file focused on its one job.
- Keep the plain Simplified Technical English style that the files use now: short sentences, active voice, common words.
- The skill must still work in a normal project where the agent can run a browser. Do not remove guidance that is only wrong for this test setup; make it conditional instead.
- Read "Earlier proposals" in the feedback. Do not repeat a rejected change; learn from why it lost.`;
}

export type Attempt = { round: number; focus: string; accepted: boolean; reason: string; summary: string; diff: string; losses: string[]; source?: string };
export type FeedbackEval = { out: string; scores: BuildScore[] };
export type CaseLabel = Map<string, string>;

function metaOf(evalOut: string, s: BuildScore): Record<string, unknown> {
  const path = join(evalOut, s.target, s.mode, String(s.sample), "meta.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function buildBlock(e: FeedbackEval, s: BuildScore, labels: CaseLabel): string {
  const m = metaOf(e.out, s);
  const head = `#### ${labels.get(s.target)} sample ${s.sample}: score ${s.objective ?? "–"}, overall ${s.judge?.overall.score ?? "–"}/10, rule pass ${s.rules?.rule_pass ?? "–"}`;
  const usage = `- Skill loaded: ${m.skill_used ? "yes" : "no"}; taste CLI calls that returned data: ${m.taste_ok_calls ?? 0}/${m.taste_calls ?? 0}; library images opened: ${m.image_reads_ok ?? 0}; turns: ${m.num_turns ?? "–"}`;
  if (!s.ok || !s.judge) return [head, usage, `- Build failed or unscored: ${s.error ?? m.error ?? "unknown"}`].join("\n");
  const dims = DIMENSIONS.map(d => `- ${d} ${s.judge![d].score}: ${s.judge![d].reason}`);
  const misses = (s.rules?.results ?? []).filter(r => r.verdict === "misses").map(r => `- MISS ${r.rule.slice(0, 90)}: ${r.reason}`);
  return [head, usage, "Judge (target vs build):", ...dims, "Rule misses:", ...(misses.length ? misses : ["- none"])].join("\n");
}

function missedRules(scores: BuildScore[]): string[] {
  const counts = new Map<string, number>();
  for (const s of scores) for (const r of s.rules?.results ?? []) if (r.verdict === "misses") counts.set(r.rule, (counts.get(r.rule) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([rule, n]) => `- ${n}/${scores.length} builds miss: ${rule}`);
}

const FULL_ATTEMPTS = 9;

function attemptBlock(a: Attempt, full: boolean): string {
  const head = `### ${a.source ? `${a.source} ` : ""}Round ${a.round}, ${a.focus}: ${a.accepted ? "PROMOTED" : "NOT PROMOTED"} (${a.reason})`;
  const losses = a.losses.length ? ["Why the other skill won some pairs (judge reasons):", ...a.losses.slice(0, full ? 12 : 3).map(l => `- ${l}`)] : [];
  const diff = a.accepted || !full ? [] : [`Diff (do not repeat it as is):\n\`\`\`diff\n${a.diff.slice(0, 4000)}\n\`\`\``];
  return [head, `Proposer summary: ${a.summary.slice(0, full ? 1000 : 500)}`, ...losses, ...diff].join("\n");
}

export function attemptsBlock(attempts: Attempt[]): string {
  if (!attempts.length) return "None yet. This is the first round.";
  const cut = attempts.length - FULL_ATTEMPTS;
  return attempts.map((a, i) => attemptBlock(a, i >= cut)).join("\n\n");
}

async function sideBySide(e: FeedbackEval, s: BuildScore, path: string): Promise<boolean> {
  const target = join(e.out, "targets", `${s.target}.jpg`);
  const build = join(e.out, s.target, s.mode, String(s.sample), "build.png");
  if (!existsSync(build)) return false;
  const out = await run(["magick", target, build, "-resize", "x900", "-background", "white", "-splice", "16x0", "+append", "-chop", "16x0", "+repage", path]);
  return out.code === 0;
}

export async function writeFeedback(dir: string, e: FeedbackEval, labels: CaseLabel, attempts: Attempt[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const score = evalScore(e.scores);
  const pairs: string[] = [];
  for (const [i, s] of worstBuilds(e.scores, 3).entries()) {
    const name = `pair-${i + 1}.png`;
    if (await sideBySide(e, s, join(dir, name))) pairs.push(`- ${name}: ${labels.get(s.target)} sample ${s.sample} (score ${s.objective}). Left = target, right = build.`);
  }
  const prompts = new Map(loadTargets().map(t => [t.id, t.prompt]));
  const cases = [...labels].map(([id, label]) => {
    const builds = e.scores.filter(s => s.target === id).sort((a, b) => a.sample - b.sample).map(s => buildBlock(e, s, labels));
    return [`### ${label}`, `Prompt: ${prompts.get(id) ?? ""}`, ...builds].join("\n\n");
  });
  const text = [
    "# Train results for the current skill (fresh builds this round)",
    `Score per build = 0.7 x (judge overall / 10) + 0.3 x (rule pass rate). Current mean: ${score.mean} +/- ${score.se} (standard error, ${score.n} builds). These numbers are for context; your version is judged head to head against the current skill.`,
    "## Rules most often missed", ...missedRules(e.scores),
    "## Worst builds, side by side", ...(pairs.length ? pairs : ["- no images"]),
    "## Every case", ...cases,
    "## Earlier proposals", attemptsBlock(attempts),
  ].join("\n\n");
  writeFileSync(join(dir, "feedback.md"), text);
}
