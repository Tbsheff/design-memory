# Design rebuild benchmark

Real UI designs posted on X are the answer key. An agent gets a short, plain prompt and builds that screen as one HTML page. We render the page, compare it with the target, and compare three modes.

| Mode | What the agent gets |
|------|---------------------|
| `baseline` | The prompt only. No user skills, CLAUDE.md, hooks or MCP. |
| `taste` | The prompt plus "Use my saved design taste (taste-use skill) for this." Only the `taste-use` skill is added, with a cleaned copy of the taste library. |
| `reference` | The prompt plus the target image (`reference.jpg` in its working directory). This is the ceiling. |

## Run

```bash
bun bench/run.ts [--targets id,id] [--modes baseline,taste,reference] [--samples N] \
  [--model sonnet] [--concurrency 3] [--out bench/runs/<timestamp>] [--timeout-minutes 20] [--budget-usd 5] [--skill-dir PATH]
bun bench/score.ts --run bench/runs/<ts> [--judge-model opus] [--concurrency 3] [--force]
bun bench/report.ts --run bench/runs/<ts>
```

Output per build: `runs/<ts>/<target>/<mode>/<sample>/{index.html,build.png,meta.json,score.json}`. Per run: `run.json`, `summary.json`, `report.html`, `blind.html`. `runs/` is git-ignored.

- `run.ts` makes a fresh empty temp directory for each build, runs headless Claude Code there, copies out `index.html`, and renders `build.png` with headless Chrome at 1440 px wide and the target's aspect ratio (no full page). `meta.json` records cost, duration, turns, tools used, tool errors, and for taste mode whether the skill loaded (`skill_used`) and how many `taste` CLI calls ran.
- `score.ts` scores each build two ways:
  - Pixels: target and build are resized to 720 px wide. `ssim` is mean SSIM over 8×8 windows (stride 4) on grayscale, 1 = same. `histogram_distance` is 1 − intersection of 8×8×8 RGB histograms, 0 = same colors. ImageMagick does the resize and pixel export; SSIM is computed in `lib.ts` instead of `magick compare`. In ImageMagick 7.1.1-47, `-metric SSIM` returns 0 for identical images, which looks like the distortion form (1 − SSIM). `-metric DSSIM` returns 1 for identical images, which is wrong for a dissimilarity. The two numbers also do not agree for different images, so neither one is used.
  - Judge: a headless `claude -p` with the same isolation as baseline and only the Read tool. It runs in a neutral temp directory that holds `1-target.jpg` and `2-build.png`, so it never sees the mode. It returns strict JSON with 0–10 scores and a one-line reason for layout, density, typography, color, components, detail and overall. The rubric is `JUDGE_PROMPT` in `lib.ts`. One retry runs if the JSON does not parse.
  - Rule judge: a second isolated `claude -p` per build gets `2-build.png`, the HTML (comments removed, `<style>` first, `<script>` last, cut at 40,000 characters) and the profile rules. It marks each rule `meets`, `misses` or `n-a` with a reason. `rule_pass = meets / (meets + misses)`; it is null when no rule applies. Rules come from `taste profile` against the run's cleaned library and are saved to `<run>/rules.json`. The judge also sees no mode, but baseline builds are judged against the same rules.
  - Objective: `score = 0.7 × overall / 10 + 0.3 × rule_pass` per build. A build that wrote no page scores 0. When `rule_pass` is null, the score is `overall / 10`. A build whose judge failed twice is left out.
  - The judge used a 1–5 scale until `full-2`, where 7 of 8 taste builds tied with baseline at 3. Old `score.json` files have no `judge_scale: 10`, so `score.ts` scores them again on the next run (no rebuild). Re-scoring costs about $0.2 per build.
- `report.ts` writes `report.html` (mode table, win counts, then every target with each build side by side) and `blind.html`.
- `blind.html` shows the target and the taste and baseline builds in a seeded random left/right order. Press 1 / 2 / 3 or click. Picks stay in localStorage; **Export JSON** downloads them; the totals show after the last pick. Serve the run folder or open the file directly; images use relative paths.

## Isolation flags

Every agent call (builds and judge) uses:

```
claude -p <prompt> --output-format json --verbose --model <m>
  --setting-sources ""                      # no user/project/local settings: no hooks, no enabled plugins, no CLAUDE.md
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'   # no MCP servers
  --permission-mode acceptEdits             # Write/Edit in the temp cwd work without prompts
  --tools <list> --allowedTools <list>      # exact tool set
  --max-budget-usd <n>
```

| Mode | `--tools` | `--allowedTools` | Extra |
|------|-----------|------------------|-------|
| baseline, reference | `Read,Write,Edit,Skill` | same | – |
| taste | `Read,Write,Edit,Skill,Bash` | `Write,Edit,Skill`; Read only as `Read(/<run>/.taste-home/media/**)` and `thumbs/**` (plus cwd and the plugin folder, which are working directories); Bash only as `Bash(taste *)`, `Bash(*/scripts/taste *)` | `--plugin-dir` and `--add-dir <run>/.taste-plugin` (a one-skill plugin with a copy of `~/.agents/skills/taste-use`), `--settings` with a PreToolUse hook (`taste-hook.ts`), `DESIGN_MEMORY_HOME=<run>/.taste-home` |
| judge | `Read` | `Read` | – |

Why these flags:

- `--bare` would be the simplest, but it reads auth only from `ANTHROPIC_API_KEY`, and this machine signs in with OAuth.
- `--setting-sources ""` drops `~/.claude/settings.json`, so its hooks and enabled plugins do not load, and the user's skills in `~/.claude/skills` and CLAUDE.md files are gone too.
- Claude Code's built-in skills (`dataviz`, `artifact-design`, `simplify` and others) still load whenever the Skill tool is on, and there is no flag to drop only them. So every mode keeps the Skill tool and the same built-ins. The only skill difference between modes is `taste-use`. In the smoke run, baseline called `dataviz`.
- `--tools` pins the tool set, so Agent, Workflow, Artifact and similar tools are not available.

Evidence (probe: "list every skill you can invoke, your tools, MCP servers, and whether your context mentions ASD-STE100 or papercut", run from an empty directory with `--model sonnet`):

| Flags | Skills | User instructions | MCP |
|-------|--------|-------------------|-----|
| none (control) | ~90 user and plugin skills | mentions ASD-STE100 and papercut: yes | many |
| baseline flags | 17 built-ins only | no | none |
| taste flags | 17 built-ins + `bench-taste:taste-use` | no | none |

### The taste hook

The first full run (`full-1`) showed that `Bash(*/scripts/taste *)` is not enough. Agents call the CLI as `S=<skill>/scripts/taste; $S profile; $S brief --topic '…'`, and Claude Code denies any command with a shell variable or quoted text it cannot check. They also `cd` into the skill folder, which resolved through the symlink to `~/.agents/skills` and was blocked. In `full-1`, every taste build loaded the skill, but most never got the profile, so its taste arm is not valid data.

The fix, for taste mode only:

- The plugin holds a real copy of the skill (`cp -RL`), and `--add-dir` adds the plugin folder, so `cd` into it works.
- `taste-hook.ts` is a PreToolUse hook passed with `--settings`. It approves a Bash command only when every part is a call to the taste CLI with a read subcommand (`profile`, `brief`, `show`, `list`, `search`), an assignment of the CLI path to a variable, a `cd` into the skill folder, `2>&1`, or `| head -N`. It rejects `$(…)`, backticks, redirects and every other command, and stays silent for them, so normal denial applies. `tests/bench-taste-hook.test.ts` covers it.

Probe with the hook: the `S=…; $S profile; $S brief …` form and the `cd <skill> && ./scripts/taste profile | head -3` form ran; `$S profile; ls ~` and `python3 -c …` were denied.

`meta.json` records each Bash call with its result (`bash`), `taste_calls` (attempts) and `taste_ok_calls` (calls that returned profile or brief text). The report counts a taste build as "taste data loaded" only when `taste_ok_calls > 0`. Every build also saves `transcript.json`, the raw Claude output.

### Read scope

A bare `Read` allow reaches any file, the answer key in `bench/targets/` too (probe: a headless call with `--allowedTools Read` read `bench/targets/agent-runs-dark.jpg`). Taste mode now allows Read only on the cleaned library's `media/` and `thumbs/`, so a skill may tell the builder to open saved screenshots that `taste brief` or `taste show` list. Probe with the taste flags: cwd file, plugin `references/aspects.md` and a library image were read; `bench/targets/agent-runs-dark.jpg` was denied. The media dir is not an `--add-dir`, because `acceptEdits` would also accept writes there. Baseline and reference keep bare `Read`; they get no file paths in their prompt.

### Skill dir

`--skill-dir PATH` loads `SKILL.md` and `references/{study-a-reference,review-implementation,aspects,memory-policy}.md` from PATH over the plugin's copy of the installed skill (scripts and the other references stay). Each run makes its own plugin copy and fails if one already exists, so two skill versions never share a run folder.

## Answer-key leakage

Two targets (`mrr-metrics-light`, `customer-table-dark`) were saved in the taste library as references. Each run makes a cleaned snapshot in `<run>/.taste-home`: `sqlite3 VACUUM INTO` copies the database, then the refs whose source matches any target post are deleted with their observations, feedback, project links, FTS rows and media files. `run.json` → `taste_home` lists what was removed. Confirmed preferences stay; none of them mention a target post. Other posts by the same authors stay in the library. That is a soft bias toward their style in taste mode, not the answer key.

## Targets

`targets.json` lists 8 targets: `id`, `image`, `source_url`, `author`, `prompt`, `width`, `height`. Prompts name the product and the screen's parts, as a PM would ask, and do not describe colors or pixels.

The images belong to their authors. They are kept here only for private benchmarking. See each `source_url`:

| id | author | source |
|----|--------|--------|
| usage-dashboard-dark | @Karthik_designs | https://x.com/Karthik_designs/status/2108558098545737786 |
| mrr-metrics-light | @ikramhsakib | https://x.com/ikramhsakib/status/2112421708028424562 |
| connect-source-light | @ikramhsakib | https://x.com/ikramhsakib/status/2111967239540998459 |
| invoice-exception-detail | @nizamdesign | https://x.com/nizamdesign/status/2112846370121846940 |
| client-detail-light | @nizamdesign | https://x.com/nizamdesign/status/2113042658075545873 |
| customer-table-dark | @sterlynavneet | https://x.com/sterlynavneet/status/2112982249956413563 |
| agent-runs-dark | @Karthik_designs | https://x.com/Karthik_designs/status/2112891659507896372 |
| finance-dashboard-light | @_heyrico | https://x.com/_heyrico/status/2111857856916201877 |

## Train and holdout

`targets.json` gives each target a `split`. Holdout: `customer-table-dark` (dark), `finance-dashboard-light` (light dashboard) and `invoice-exception-detail` (detail page). The first two come from authors with no other target. Train: the other five. `client-detail-light` (train) and `invoice-exception-detail` (holdout) share an author, so holdout is not fully independent of train style. The cleaned library still removes the answer-key posts of all eight targets.

## Optimizer

```bash
bun bench/optimize.ts --rounds 5 --samples 2 --candidates 3 --budget-usd 60 \
  [--holdout-samples 3] [--train-targets id,id] [--holdout-targets id,id] [--model sonnet] [--judge-model opus] \
  [--proposer-model opus] [--concurrency 6] [--build-budget-usd 5] [--out bench/optimize/<timestamp>] \
  [--accept-on closer|rules] [--min-win-rate 0.6] [--max-p 0.2] [--min-guard-rate 0.4]
bun bench/optimize.ts --resume bench/optimize/<dir>
```

It improves copies of the taste-use skill (`skills/taste-use/SKILL.md` and the four references). It never edits the repo files.

The first loop (`full-1`) compared absolute 0–10 scores. Their standard error (about 0.015–0.024 with 2 samples) was as large as the gains, the incumbent's cached score was biased by selection, and one proposal per round with a stop after 2 rejections ended it after 2 rounds. The loop now compares builds head to head.

Each round k:

1. Build the incumbent skill fresh on train (taste mode) and score it (judge and rule judge). Round 1 builds the original. These builds are the proposers' feedback and the comparison side for this round, so the incumbent never keeps a score that won a selection.
2. `--candidates` proposers (opus) run in parallel from the incumbent, each with one focus: `craft` (what makes a short prompt give a dense, credible product screen), `process` (step order, what to plan before code, how to check without a browser), `rules` (turn each profile rule into CSS decisions and check them everywhere). Each runs in a fresh temp folder that holds only `skill/` (editable) and `feedback/`: train judge reasons and rule misses per build (labeled `case-N`), the most-missed rules, side-by-side PNGs of the 3 worst builds, and every earlier candidate with its focus, verdict, diff (when not promoted) and pairwise loss reasons. Read is allowed only in that folder, and Edit and Write only in `skill/`. It never sees holdout images, reasons or names.
3. The lint from before rejects a candidate with no edits, a changed `name: taste-use` frontmatter, more than 95 lines in SKILL.md, a hex color, a broken reference link, or a target id, author or product name.
4. Each candidate builds train (same targets and samples). Candidates are not scored on the absolute scale, to save money.
5. Pairwise judge (opus, `pairwise.ts`, `pair-judge.ts`): for each target × sample, a blind call gets `1-target.jpg`, `2-left.png`, `3-right.png` and the profile rules, and answers which build is closer to the target and which follows the rules better (or tie), each with a one-line reason. It runs twice per pair, incumbent left and then candidate left. The two orders make one outcome: a win in both, or a win and a tie, is a win; a win for each side (split, from position bias) is a tie. A build that failed loses without a call. Each call is cached in `round-k/cand-<focus>/pairs/<target>-<sample>-<order>.json`, with `left` naming the arm (`a` = incumbent, `b` = candidate).
6. Accept a candidate when, on `--accept-on` (default `closer`), its win rate over non-tie pairs is at least `--min-win-rate` and the one-sided sign test p is below `--max-p`, and its win rate on the other question is at least `--min-guard-rate` (or it has no non-ties there). With 10 pairs, 7 wins and 3 losses gives p 0.172; 6–4 gives p 0.377. The best passing candidate (win rate, then p) becomes the incumbent. There is no stop on rejections.
7. Before each round, the loop runs as many candidates (up to `--candidates`) as fit: spent + the round estimate + a holdout reserve must stay within `--budget-usd`. When not even one candidate fits, it stops. The estimates use the measured cost per build, per scored build, per pair call and per proposer. The focus order rotates by round, so a round with fewer candidates does not always drop the same focus.

Holdout: baseline and the original skill (one eval) and the best skill, `--holdout-samples` each, all scored on the absolute scale. Pairwise best vs baseline and best vs original (when the best is not the original) on the same samples, both orders. `<out>/final.json` and `<out>/report.html` show the holdout table, the pairwise win rates with counts, every round's candidates and the skill diff (original → best).

Output: `<out>/history.json` (one record per round: incumbent, its fresh scores, each candidate with focus, diff, lint, pairwise summary, decision, loss reasons and cost, the promoted focus, spent and cost totals), `<out>/round-k/cand-<focus>/{candidate,feedback,proposer-transcript.json,pairs}`, `<out>/evals/<name>/` (normal run folders), `<out>/holdout-pairs/`. `bench/optimize/` is git-ignored.

`--resume <dir>` reads `options.json` and `history.json`, restores the incumbent, spent cost and earlier candidates, and redoes the unfinished round: finished builds, scores, proposals and pair calls are reused.

## Caveats

- Most targets sit on a gray backdrop inside a rounded frame. Builds usually fill the page, so SSIM and the histogram partly measure the frame. Reference builds often copy the frame too. The judge is told to ignore the frame.
- `agent-runs-dark` is a zoomed crop with the sidebar cut off. Its prompt asks for that crop.
- The taste-use skill asks the agent to look at the rendered UI before it finishes. No mode can run a browser (agents try Chrome and are denied), so taste builds skip that step.
- The judge's old 1–5 integer scale was coarse. In `full-2`, all 8 baseline builds got overall 3, and 7 of 8 taste builds did too. The 0–10 scale replaces it; still use SSIM, the dimension scores, and `blind.html` alongside it.
- A reference build can look worse than the prompt-only builds when its layout breaks. In `full-2`, `client-detail-light` reference overlaps its own sidebar, so the judge gave it 2 even though its SSIM is high. No mode looks at its own render.
- One sample per cell is noisy. Use `--samples 3` or more before you trust a small difference.
