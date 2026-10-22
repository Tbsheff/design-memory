import { existsSync, writeFileSync } from "node:fs";
import { run } from "./tools.ts";
import { join, relative } from "node:path";
import type { ArmScore, MeanSe } from "./objective.ts";
import { guardsOf, QUESTIONS, statLine } from "./pairwise.ts";
import type { AcceptRule, PairSummary, Question } from "./pairwise.ts";
import type { CandidateRecord, RoundRecord } from "./resume.ts";

type Final = {
  stop_reason: string | null; best_round: number; holdout_targets: string[]; holdout_samples: number; total_cost_usd: number;
  holdout: Record<string, ArmScore>; holdout_runs: Record<string, string>;
  holdout_pairs: Record<string, PairSummary>; accept_rule: AcceptRule; changes?: { round: number; note: string }[];
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const f = (n: number | undefined, p = 3) => (n === undefined || !Number.isFinite(n) ? "–" : n.toFixed(p));
const pm = (m: MeanSe | null | undefined, p = 3) => (m ? `${f(m.mean, p)} ± ${f(m.se, p)}` : "–");

const STYLE = `body{margin:0;background:#fafaf9;color:#1b1c1d;font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
main{max-width:1500px;margin:0 auto;padding:32px 28px 80px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:36px 0 10px}
.sub{color:#6b7075}table{border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid #e3e4e2;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7075}td.n{text-align:right;white-space:nowrap}.ok{color:#3f6b2f;font-weight:600}.no{color:#a33}
pre{background:#fff;border:1px solid #e3e4e2;border-radius:8px;padding:12px;overflow:auto;font:12px/1.45 ui-monospace,Menlo,monospace}.add{color:#1d6b2a;background:#eaf6ec;display:block}.del{color:#9b2c2c;background:#fbecec;display:block}.hunk{color:#6b7075;display:block}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:20px}.grid img{width:100%;border-radius:6px;outline:1px solid rgba(0,0,0,.1);outline-offset:-1px}.grid p{margin:0 0 4px;font-weight:600}`;

function pairCell(p: PairSummary | null): string {
  if (!p) return "<td>–</td><td>–</td><td>–</td><td>–</td>";
  const cell = (q: Question) => `<td>${p[q] ? esc(statLine(p[q])) : "not asked"}</td>`;
  return `${QUESTIONS.map(cell).join("")}<td class="n">${QUESTIONS.map(q => p.split[q] ?? "–").join(" / ")} of ${p.pairs}</td>`;
}

function candidateRow(r: RoundRecord, c: CandidateRecord): string {
  const promoted = r.promoted === c.focus;
  const status = promoted ? "promoted" : c.accepted ? "passed" : "no";
  return `<tr><td>${r.round}</td><td>${esc(c.focus)}</td>${pairCell(c.pairs)}<td class="${promoted ? "ok" : "no"}">${status}</td><td class="n">$${f(c.cost.total, 2)}</td><td>${esc(c.reason)}</td><td><details><summary>summary</summary>${esc(c.summary)}</details></td></tr>`;
}

function roundsTable(rows: RoundRecord[]): string {
  const body = rows.map(r => {
    const inc = `<tr><td>${r.round}</td><td>incumbent (round ${r.incumbent_from}); judged: ${esc((r.questions ?? ["closer", "rules"]).join(", "))}</td><td colspan="4">fresh builds: score ${pm(r.incumbent_score.score)}, overall ${pm(r.incumbent_score.overall, 2)}, rule pass ${pm(r.incumbent_score.rule_pass)}</td><td></td><td class="n">round $${f(r.cost, 2)}</td><td></td><td></td></tr>`;
    const change = r.change ? `<tr><td colspan="10"><b>Change from this round:</b> ${esc(r.change)}</td></tr>` : "";
    return change + inc + r.candidates.map(c => candidateRow(r, c)).join("");
  }).join("");
  return `<table><thead><tr><th>Round</th><th>Arm</th><th>Closer W-L-T</th><th>Rules W-L-T</th><th>Calmer W-L-T</th><th>Split orders (closer / rules / calmer)</th><th>Status</th><th>Cost</th><th>Decision</th><th>Proposer</th></tr></thead><tbody>${body}</tbody></table>`;
}

function changesHtml(changes: { round: number; note: string }[] | undefined): string {
  if (!changes?.length) return "";
  return `<h2>Changes during the run</h2><ul>${changes.map(c => `<li><b>From round ${c.round}:</b> ${esc(c.note)}</li>`).join("")}</ul>`;
}

function holdoutTable(final: Final): string {
  const arms = Object.keys(final.holdout);
  const body = arms.map(a => `<tr><td>${a}</td><td class="n">${pm(final.holdout[a].score)}</td><td class="n">${pm(final.holdout[a].overall, 2)}</td><td class="n">${pm(final.holdout[a].rule_pass)}</td><td class="n">${final.holdout[a].score.n}</td></tr>`).join("");
  const pairs = Object.entries(final.holdout_pairs).map(([k, p]) => `<tr><td>${esc(k.replaceAll("_", " "))}</td>${pairCell(p)}</tr>`).join("");
  return `<table><thead><tr><th>Arm</th><th>Score ± se</th><th>Overall /10</th><th>Rule pass</th><th>Builds</th></tr></thead><tbody>${body}</tbody></table>
<h3>Pairwise (W-L-T is wins-losses-ties for the first arm named)</h3><table><thead><tr><th>Comparison</th><th>Closer</th><th>Rules</th><th>Calmer</th><th>Split orders</th></tr></thead><tbody>${pairs}</tbody></table>`;
}

function diffHtml(diff: string): string {
  if (!diff.trim()) return "<p>The best skill is the original skill. No changes.</p>";
  const lines = diff.split("\n").map(l => {
    const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "";
    return cls ? `<span class="${cls}">${esc(l)}</span>` : `${esc(l)}\n`;
  });
  return `<pre>${lines.join("")}</pre>`;
}

function img(opt: string, path: string, label: string): string {
  return existsSync(path) ? `<div><p>${label}</p><img loading="lazy" src="${esc(relative(opt, path))}" alt="${label}"></div>` : `<div><p>${label}</p>missing</div>`;
}

function holdoutImages(opt: string, final: Final): string {
  const rows: string[] = [];
  const runs = Object.entries(final.holdout_runs);
  for (const t of final.holdout_targets) {
    for (let n = 1; n <= final.holdout_samples; n++) {
      const cell = (dir: string, mode: string) => join(dir, t, mode, String(n), "build.png");
      const builds = runs.map(([name, dir]) => img(opt, cell(dir, "taste"), `${name} skill`)).join("");
      rows.push(`<h3>${esc(t)} #${n}</h3><div class="grid" style="grid-template-columns:repeat(${runs.length + 2},minmax(0,1fr))">${img(opt, join(final.holdout_runs.original!, "targets", `${t}.jpg`), "target")}${img(opt, cell(final.holdout_runs.original!, "baseline"), "baseline")}${builds}</div>`);
    }
  }
  return rows.join("");
}

export async function contactSheet(opt: string, final: Pick<Final, "holdout_targets" | "holdout_runs">): Promise<string | null> {
  const runs = Object.entries(final.holdout_runs);
  const tiles: string[] = [];
  for (const t of final.holdout_targets) {
    tiles.push("-label", `${t}: target`, join(final.holdout_runs.original!, "targets", `${t}.jpg`));
    for (const [name, dir] of runs) tiles.push("-label", `${name} #1`, join(dir, t, "taste", "1", "build.png"));
  }
  const out = join(opt, "holdout-sheet.png");
  const res = await run(["magick", "montage", "-pointsize", "18", ...tiles, "-tile", `${runs.length + 1}x${final.holdout_targets.length}`, "-geometry", "640x+10+10", "-background", "white", out]);
  return res.code === 0 ? out : null;
}

export async function writeOptimizeReport(opt: string, final: Final, rows: RoundRecord[], diff: string, sheet: string | null = null): Promise<void> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>taste-use skill optimization</title><style>${STYLE}</style></head><body><main>
<h1>taste-use skill optimization</h1><p class="sub">${esc(opt)} · stop: ${esc(final.stop_reason)} · best round ${final.best_round} · total $${f(final.total_cost_usd, 2)}</p>
<p class="sub">Each round builds the incumbent fresh, then each candidate. A blind judge compares each candidate build with the incumbent build for the same case, in both left/right orders. One pair = one outcome: both orders agree, or one wins and one ties; split orders count as a tie. Accept on ${esc(final.accept_rule.on)}: win rate ≥ ${final.accept_rule.minWinRate} over non-ties and sign test p &lt; ${final.accept_rule.maxP}; each guard (${esc(guardsOf(final.accept_rule).join(", "))}) needs win rate ≥ ${final.accept_rule.minGuardRate} and must not lose with sign test p &lt; ${final.accept_rule.guardLossP}. A guard question that a round did not ask is skipped. Score per build = 0.7 × judge overall / 10 + 0.3 × rule pass rate.</p>
<h2>Holdout (${final.holdout_targets.length} targets × ${final.holdout_samples} samples)</h2>${holdoutTable(final)}
${changesHtml(final.changes)}<h2>Rounds (train, candidate vs incumbent)</h2>${roundsTable(rows)}
<h2>Skill diff: original → best</h2>${diffHtml(diff)}
${sheet ? `<h2>Holdout contact sheet (sample 1)</h2><img style="width:100%" src="${esc(relative(opt, sheet))}" alt="holdout contact sheet">` : ""}
<h2>Holdout builds</h2>${holdoutImages(opt, final)}
</main></body></html>`;
  writeFileSync(join(opt, "report.html"), html);
}
