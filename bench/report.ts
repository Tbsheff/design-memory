import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DIMENSIONS, MODES, readFlags, seededShuffleSides, stats } from "./lib.ts";
import type { BuildScore, Mode, Target } from "./lib.ts";
import { loadTargets } from "./run.ts";
import { buildDirs } from "./score.ts";

type Meta = { target: string; mode: Mode; sample: number; ok: boolean; error?: string; cost_usd?: number; num_turns?: number; skill_used?: boolean; taste_calls?: number; taste_ok_calls?: number };
type Build = { dir: string; rel: string; meta: Meta; score: BuildScore | null };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (n: number | undefined | null, places = 2) => (n === undefined || n === null || !Number.isFinite(n) ? "–" : n.toFixed(places));

const STYLE = `:root{color-scheme:light;--text:#1b1c1d;--muted:#6b7075;--line:#e3e4e2;--bg:#fafaf9;--accent:#3f6b2f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:1680px;margin:0 auto;padding:32px 28px 80px}h1{font-size:20px;margin:0 0 4px;letter-spacing:-.2px}h2{font-size:15px;margin:0;letter-spacing:-.1px}
.sub{color:var(--muted);margin:0 0 24px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}th:first-child,td:first-child{text-align:left}
section{margin-top:44px}.head{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px}.head a{color:var(--muted);font-size:12px}
.prompt{color:var(--muted);margin:0 0 12px;max-width:900px}.row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;align-items:start}
.cell img{width:100%;display:block;border-radius:6px;outline:1px solid rgba(0,0,0,.1);outline-offset:-1px}.label{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 6px;font-weight:600}
.label small{font-weight:400;color:var(--muted)}.big{font-size:18px;font-weight:650}.dims{color:var(--muted);font-size:12px;margin-top:6px;font-variant-numeric:tabular-nums}
details{margin-top:6px;color:var(--muted);font-size:12px}details li{margin:2px 0}.fail{color:#a33;padding:24px 0}.wins{margin-top:12px;color:var(--muted)}.wins b{color:var(--text)}`;

function loadBuilds(out: string): Build[] {
  return buildDirs(out).map(dir => ({
    dir,
    rel: relative(out, dir),
    meta: JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")),
    score: existsSync(join(dir, "score.json")) ? JSON.parse(readFileSync(join(dir, "score.json"), "utf8")) : null,
  }));
}

function modeRow(mode: Mode, builds: Build[]): string {
  const mine = builds.filter(b => b.meta.mode === mode);
  if (!mine.length) return "";
  const scored = mine.map(b => b.score).filter((s): s is BuildScore => !!s?.ok);
  const mean = (f: (s: BuildScore) => number | undefined) => stats(scored.map(s => f(s) ?? NaN));
  const overall = mean(s => s.judge?.overall.score);
  const dims = DIMENSIONS.filter(d => d !== "overall").map(d => `<td>${fmt(mean(s => s.judge?.[d].score)?.mean)}</td>`).join("");
  const cost = mine.reduce((a, b) => a + (b.meta.cost_usd ?? 0), 0);
  const skill = mode === "taste" ? `${mine.filter(b => b.meta.skill_used && (b.meta.taste_ok_calls ?? 0) > 0).length}/${mine.length}` : "–";
  return `<tr><td>${mode}</td><td>${mine.length}</td><td>${mine.length - scored.length}</td><td><b>${fmt(overall?.mean)}</b> ± ${fmt(overall?.sd)}</td><td>${fmt(mean(s => s.rules?.rule_pass ?? undefined)?.mean, 3)}</td><td>${fmt(mean(s => s.objective ?? undefined)?.mean, 3)}</td>${dims}<td>${fmt(mean(s => s.ssim)?.mean, 3)}</td><td>${fmt(mean(s => s.histogram_distance)?.mean, 3)}</td><td>$${fmt(cost)}</td><td>${fmt(stats(mine.map(b => b.meta.num_turns ?? NaN))?.mean, 1)}</td><td>${skill}</td></tr>`;
}

function modeTable(builds: Build[]): string {
  const dimHeads = DIMENSIONS.filter(d => d !== "overall").map(d => `<th>${d}</th>`).join("");
  return `<table><thead><tr><th>Mode</th><th>Builds</th><th>Failed</th><th>Overall (0–10)</th><th>Rule pass</th><th>Objective</th>${dimHeads}<th>SSIM</th><th>Hist dist</th><th>Build cost</th><th>Turns</th><th>Taste data loaded</th></tr></thead><tbody>${MODES.map(m => modeRow(m, builds)).join("")}</tbody></table>`;
}

function overallFor(builds: Build[], target: string, mode: Mode): number | undefined {
  return stats(builds.filter(b => b.meta.target === target && b.meta.mode === mode && b.score?.ok).map(b => b.score!.judge!.overall.score))?.mean;
}

function winLine(builds: Build[], targets: Target[], a: Mode, b: Mode): string {
  const tally = { [a]: 0, [b]: 0, tie: 0 } as Record<string, number>;
  for (const t of targets) {
    const [x, y] = [overallFor(builds, t.id, a), overallFor(builds, t.id, b)];
    if (x === undefined || y === undefined) continue;
    const key = x === y ? "tie" : x > y ? a : b;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return `<div><b>${a} vs ${b}</b> per target (mean overall): ${a} ${tally[a]} · ${b} ${tally[b]} · tie ${tally.tie}</div>`;
}

function judgeDetails(score: BuildScore): string {
  if (!score.judge) return "";
  const items = DIMENSIONS.map(d => `<li><b>${d} ${score.judge![d].score}</b> — ${esc(score.judge![d].reason)}</li>`).join("");
  return `<details><summary>Judge reasons</summary><ul>${items}</ul></details>`;
}

function buildCell(build: Build | undefined, mode: Mode): string {
  if (!build) return `<div class="cell"><p class="label">${mode}</p><p class="fail">not run</p></div>`;
  const s = build.score;
  const extra = mode === "taste" ? ` · skill ${build.meta.skill_used ? "yes" : "no"}, taste CLI ${build.meta.taste_ok_calls ?? 0}/${build.meta.taste_calls ?? 0} ok` : "";
  const label = `<p class="label">${mode} #${build.meta.sample}<small>$${fmt(build.meta.cost_usd)} · ${build.meta.num_turns ?? "–"} turns${extra}</small></p>`;
  if (!build.meta.ok) return `<div class="cell">${label}<p class="fail">${esc(build.meta.error)}</p></div>`;
  const dims = s?.judge ? DIMENSIONS.filter(d => d !== "overall").map(d => `${d} ${s.judge![d].score}`).join(" · ") : esc(s?.error ?? "not scored");
  return `<div class="cell">${label}<a href="${build.rel}/index.html"><img loading="lazy" src="${build.rel}/build.png" alt="${mode} build"></a><div class="dims"><span class="big">${s?.judge?.overall.score ?? "–"}</span> overall · rules ${fmt(s?.rules?.rule_pass, 2)} · SSIM ${fmt(s?.ssim, 3)} · hist ${fmt(s?.histogram_distance, 3)}<br>${dims}</div>${s ? judgeDetails(s) : ""}</div>`;
}

function targetSection(target: Target, builds: Build[]): string {
  const mine = builds.filter(b => b.meta.target === target.id);
  if (!mine.length) return "";
  const samples = [...new Set(mine.map(b => b.meta.sample))].sort((a, b) => a - b);
  const rows = samples.map(n => `<div class="row"><div class="cell"><p class="label">target<small>@${esc(target.author)}</small></p><img loading="lazy" src="targets/${target.id}.jpg" alt="target"></div>${MODES.map(m => buildCell(mine.find(b => b.meta.mode === m && b.meta.sample === n), m)).join("")}</div>`);
  return `<section><div class="head"><h2>${target.id}</h2><a href="${esc(target.source_url)}">${esc(target.source_url)}</a></div><p class="prompt">${esc(target.prompt)}</p>${rows.join("")}</section>`;
}

function reportHtml(out: string, builds: Build[], targets: Target[]): string {
  const summary = existsSync(join(out, "summary.json")) ? JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) : {};
  const wall = summary.wall_ms ? `${Math.round(summary.wall_ms / 60000)} min wall` : "";
  const sub = [`${builds.length} builds`, wall, `build $${fmt(summary.build_cost_usd)}`, `judge $${fmt(summary.judge_cost_usd)} (${esc(summary.judge_model ?? "?")})`].filter(Boolean).join(" · ");
  const wins = [winLine(builds, targets, "taste", "baseline"), winLine(builds, targets, "reference", "baseline")].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Design rebuild benchmark</title><style>${STYLE}</style></head><body><main>
<h1>Design rebuild benchmark</h1><p class="sub">${esc(relative(process.cwd(), out))} · ${sub} · <a href="blind.html">blind compare</a></p>
${modeTable(builds)}<div class="wins">${wins}</div>${targets.map(t => targetSection(t, builds)).join("")}</main></body></html>`;
}

export type BlindPair = { id: string; target: string; image: string; left: string; right: string; taste: "left" | "right" };

export function blindPairs(builds: Build[], seed: number): BlindPair[] {
  const ok = (mode: Mode) => builds.filter(b => b.meta.mode === mode && b.meta.ok);
  const pairs = ok("taste").flatMap(t => {
    const base = ok("baseline").find(b => b.meta.target === t.meta.target && b.meta.sample === t.meta.sample);
    return base ? [{ taste: t, base }] : [];
  });
  const flips = seededShuffleSides(pairs.map(p => p.taste.rel), seed);
  return pairs.map(({ taste, base }) => {
    const tasteLeft = flips[taste.rel]!;
    const [left, right] = tasteLeft ? [taste, base] : [base, taste];
    return { id: `${taste.meta.target}#${taste.meta.sample}`, target: taste.meta.target, image: `targets/${taste.meta.target}.jpg`, left: `${left.rel}/build.png`, right: `${right.rel}/build.png`, taste: tasteLeft ? "left" : "right" };
  });
}

const BLIND_STYLE = `*{box-sizing:border-box}body{margin:0;background:#f4f4f2;color:#1b1c1d;font:13px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
main{max-width:1800px;margin:0 auto;padding:20px 24px 60px}header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:14px}h1{font-size:16px;margin:0}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;align-items:start}figure{margin:0}figcaption{font-weight:600;margin-bottom:6px}img{width:100%;display:block;border-radius:6px;outline:1px solid rgba(0,0,0,.1);outline-offset:-1px}
.actions{display:flex;gap:8px;justify-content:center;margin:18px 0}button{font:inherit;padding:9px 16px;border-radius:7px;border:1px solid #cfd0cc;background:#fff;cursor:pointer}button:hover{border-color:#888}
button.primary{background:#1b1c1d;color:#fff;border-color:#1b1c1d}.muted{color:#6b7075}table{border-collapse:collapse;margin-top:12px}td,th{padding:5px 10px;border-bottom:1px solid #ddd;text-align:left}.hidden{display:none}`;

const BLIND_SCRIPT = `const key="design-bench-blind:"+RUN;let picks=JSON.parse(localStorage.getItem(key)||"{}");let i=PAIRS.findIndex(p=>!picks[p.id]);if(i<0)i=PAIRS.length;
const $=id=>document.getElementById(id);
function save(){localStorage.setItem(key,JSON.stringify(picks))}
function show(){$("progress").textContent=Math.min(i+1,PAIRS.length)+" / "+PAIRS.length+" · "+Object.keys(picks).length+" picked";if(i>=PAIRS.length){$("pick").classList.add("hidden");reveal();return}
$("pick").classList.remove("hidden");$("result").classList.add("hidden");const p=PAIRS[i];$("tname").textContent=p.target;$("t").src=p.image;$("l").src=p.left;$("r").src=p.right}
function pick(side){picks[PAIRS[i].id]=side;save();i++;show()}
function outcome(p){const s=picks[p.id];if(!s)return"unpicked";if(s==="same")return"same";return s===p.taste?"taste":"baseline"}
function reveal(){const t={taste:0,baseline:0,same:0,unpicked:0};const rows=PAIRS.map(p=>{const o=outcome(p);t[o]++;return"<tr><td>"+p.id+"</td><td>"+(picks[p.id]||"–")+"</td><td>taste was "+p.taste+"</td><td><b>"+o+"</b></td></tr>"}).join("");
$("result").classList.remove("hidden");$("totals").textContent="Closer to target: taste "+t.taste+" · baseline "+t.baseline+" · same "+t.same+(t.unpicked?" · unpicked "+t.unpicked:"");$("rows").innerHTML=rows}
function exportJson(){const data={run:RUN,exported:new Date().toISOString(),picks:PAIRS.map(p=>({id:p.id,pick:picks[p.id]||null,taste_side:p.taste,closer:outcome(p)}))};const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));a.download="blind-picks.json";a.click()}
function back(){if(i>0){i--;show()}}
function reset(){if(confirm("Clear all picks?")){picks={};save();i=0;show()}}
document.addEventListener("keydown",e=>{if(i>=PAIRS.length)return;if(e.key==="1")pick("left");if(e.key==="2")pick("same");if(e.key==="3")pick("right")});show();`;

function blindHtml(runName: string, pairs: BlindPair[]): string {
  const data = `const RUN=${JSON.stringify(runName)};const PAIRS=${JSON.stringify(pairs).replaceAll("<", "\\u003c")};`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blind compare</title><style>${BLIND_STYLE}</style></head><body><main>
<header><h1>Which build is closer to the target?</h1><span class="muted" id="progress"></span><span><button onclick="back()">Back</button> <button onclick="exportJson()">Export JSON</button> <button onclick="reset()">Reset</button></span></header>
<div id="pick"><div class="grid"><figure><figcaption>Target · <span class="muted" id="tname"></span></figcaption><img id="t" alt="target"></figure><figure><figcaption>A</figcaption><img id="l" alt="build A"></figure><figure><figcaption>B</figcaption><img id="r" alt="build B"></figure></div>
<div class="actions"><button class="primary" onclick="pick('left')">A is closer (1)</button><button onclick="pick('same')">Same (2)</button><button class="primary" onclick="pick('right')">B is closer (3)</button></div></div>
<div id="result" class="hidden"><h1 id="totals"></h1><table><thead><tr><th>Pair</th><th>Your pick</th><th>Sides</th><th>Closer</th></tr></thead><tbody id="rows"></tbody></table></div>
</main><script>${data}${BLIND_SCRIPT}</script></body></html>`;
}

function seedFrom(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

function main() {
  const run = readFlags(process.argv.slice(2)).get("run");
  if (!run || run === "true") throw new Error("--run <dir> is required");
  const out = resolve(run);
  const builds = loadBuilds(out);
  const ids = new Set(builds.map(b => b.meta.target));
  const targets = loadTargets().filter(t => ids.has(t.id));
  const runName = out.split("/").at(-1)!;
  writeFileSync(join(out, "report.html"), reportHtml(out, builds, targets));
  writeFileSync(join(out, "blind.html"), blindHtml(runName, blindPairs(builds, seedFrom(runName))));
  console.log(`wrote ${join(out, "report.html")} and ${join(out, "blind.html")}`);
}

if (import.meta.main) main();
