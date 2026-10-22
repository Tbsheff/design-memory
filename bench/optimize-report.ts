import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { MeanSe } from "./objective.ts";

type Arm = { score: MeanSe; overall: MeanSe; rule_pass: MeanSe };
type Final = {
  stop_reason: string | null; best_round: number; holdout_targets: string[]; holdout_samples: number; total_cost_usd: number;
  holdout: Record<"baseline" | "original" | "best", Arm>; holdout_runs: { original: string; best: string };
  holdout_compare: Record<string, { diff: number; se: number; targets: number }>;
};
type Row = { round: number; train: MeanSe | null; accepted: boolean; reason: string; cost: { total: number }; proposer_summary: string };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const f = (n: number | undefined, p = 3) => (n === undefined || !Number.isFinite(n) ? "–" : n.toFixed(p));
const pm = (m: MeanSe | null | undefined, p = 3) => (m ? `${f(m.mean, p)} ± ${f(m.se, p)}` : "–");

const STYLE = `body{margin:0;background:#fafaf9;color:#1b1c1d;font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
main{max-width:1500px;margin:0 auto;padding:32px 28px 80px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:36px 0 10px}
.sub{color:#6b7075}table{border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid #e3e4e2;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7075}td.n{text-align:right;white-space:nowrap}.ok{color:#3f6b2f;font-weight:600}.no{color:#a33}
pre{background:#fff;border:1px solid #e3e4e2;border-radius:8px;padding:12px;overflow:auto;font:12px/1.45 ui-monospace,Menlo,monospace}.add{color:#1d6b2a;background:#eaf6ec;display:block}.del{color:#9b2c2c;background:#fbecec;display:block}.hunk{color:#6b7075;display:block}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:20px}.grid img{width:100%;border-radius:6px;outline:1px solid rgba(0,0,0,.1);outline-offset:-1px}.grid p{margin:0 0 4px;font-weight:600}`;

function roundsTable(rows: Row[]): string {
  const body = rows.map(r => `<tr><td>${r.round}</td><td class="n">${pm(r.train)}</td><td class="${r.accepted ? "ok" : "no"}">${r.round === 0 ? "start" : r.accepted ? "yes" : "no"}</td><td class="n">$${f(r.cost.total, 2)}</td><td>${esc(r.reason)}</td><td><details><summary>summary</summary>${esc(r.proposer_summary)}</details></td></tr>`).join("");
  return `<table><thead><tr><th>Round</th><th>Train score ± se</th><th>Accepted</th><th>Cost</th><th>Decision</th><th>Proposer</th></tr></thead><tbody>${body}</tbody></table>`;
}

function holdoutTable(final: Final): string {
  const arms = ["baseline", "original", "best"] as const;
  const body = arms.map(a => `<tr><td>${a}</td><td class="n">${pm(final.holdout[a].score)}</td><td class="n">${pm(final.holdout[a].overall, 2)}</td><td class="n">${pm(final.holdout[a].rule_pass)}</td><td class="n">${final.holdout[a].score.n}</td></tr>`).join("");
  const cmp = Object.entries(final.holdout_compare).map(([k, c]) => `<li>${esc(k.replaceAll("_", " "))}: paired diff ${f(c.diff)} ± ${f(c.se)} over ${c.targets} targets</li>`).join("");
  return `<table><thead><tr><th>Arm</th><th>Score ± se</th><th>Overall /10</th><th>Rule pass</th><th>Builds</th></tr></thead><tbody>${body}</tbody></table><ul>${cmp}</ul>`;
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
  for (const t of final.holdout_targets) {
    for (let n = 1; n <= final.holdout_samples; n++) {
      const cell = (dir: string, mode: string) => join(dir, t, mode, String(n), "build.png");
      rows.push(`<h3>${esc(t)} #${n}</h3><div class="grid">${img(opt, join(final.holdout_runs.original, "targets", `${t}.jpg`), "target")}${img(opt, cell(final.holdout_runs.original, "baseline"), "baseline")}${img(opt, cell(final.holdout_runs.original, "taste"), "original skill")}${img(opt, cell(final.holdout_runs.best, "taste"), "best skill")}</div>`);
    }
  }
  return rows.join("");
}

export async function writeOptimizeReport(opt: string, final: Final, rows: Row[], diff: string): Promise<void> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>taste-use skill optimization</title><style>${STYLE}</style></head><body><main>
<h1>taste-use skill optimization</h1><p class="sub">${esc(opt)} · stop: ${esc(final.stop_reason)} · best round ${final.best_round} · total $${f(final.total_cost_usd, 2)}</p>
<p class="sub">Score per build = 0.7 × judge overall / 10 + 0.3 × rule pass rate. Train numbers have selection bias; holdout is the honest check.</p>
<h2>Holdout (${final.holdout_targets.length} targets × ${final.holdout_samples} samples)</h2>${holdoutTable(final)}
<h2>Rounds (train)</h2>${roundsTable(rows)}
<h2>Skill diff: original → best</h2>${diffHtml(diff)}
<h2>Holdout builds</h2>${holdoutImages(opt, final)}
</main></body></html>`;
  writeFileSync(join(opt, "report.html"), html);
}
