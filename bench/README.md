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
bun bench/optimize.ts --rounds 5 --samples 2 --budget-usd 45 \
  [--holdout-samples N] [--train-targets id,id] [--holdout-targets id,id] [--model sonnet] [--judge-model opus] \
  [--proposer-model opus] [--concurrency 5] [--build-budget-usd 5] [--out bench/optimize/<timestamp>]
```

It improves copies of the taste-use skill (`skills/taste-use/SKILL.md` and the four references). It never edits the repo files.

1. Round 0 copies the repo skill to `<out>/original/` and evaluates it on train (taste mode). That result is the cached incumbent.
2. Each round, a proposer (`claude -p`, opus) runs in a fresh temp folder that holds only `skill/` (editable) and `feedback/`: train judge reasons and rule misses per build, labeled `case-N`, the most-missed rules, side-by-side PNGs (target | build) of the 3 worst builds, and earlier proposals with their verdicts and rejected diffs. Read is allowed only in that folder, and Edit and Write only in `skill/`. Probe: it could not read `bench/targets/` or `bench/runs/`, nor write outside the folder. It never sees holdout images, reasons or names.
3. Before it spends money, a lint rejects a candidate with no edits, a changed `name: taste-use` frontmatter, more than 95 lines in SKILL.md, a hex color, a broken reference link, or a target id, author or product name.
4. The candidate is evaluated on train. Acceptance compares per-target means paired with the incumbent: accept when the mean paired gain is at least 0.02 and greater than its standard error. Paired differences remove the spread between targets, which is larger than the effect we look for.
5. The loop stops after `--rounds`, after 2 rejections in a row, or when spent + the largest round so far + a holdout reserve passes `--budget-usd`.
6. Holdout: baseline, the original skill and the best skill, `--holdout-samples` each. `<out>/final.json` and `<out>/report.html` show the holdout table, the round table and the skill diff (original → best).

Output: `<out>/history.json` (round, diff, lint, train score ± se, comparison, accepted, cost), `<out>/round-k/{candidate,feedback,proposer-transcript.json}`, `<out>/evals/<name>/` (normal run folders). `bench/optimize/` is git-ignored.

Caveat: the incumbent's cached score is the one that won selection, so it is biased upward. Later candidates must beat a lucky number, and early stops are more likely. Only holdout is a fair estimate.

## Caveats

- Most targets sit on a gray backdrop inside a rounded frame. Builds usually fill the page, so SSIM and the histogram partly measure the frame. Reference builds often copy the frame too. The judge is told to ignore the frame.
- `agent-runs-dark` is a zoomed crop with the sidebar cut off. Its prompt asks for that crop.
- The taste-use skill asks the agent to look at the rendered UI before it finishes. No mode can run a browser (agents try Chrome and are denied), so taste builds skip that step.
- The judge's old 1–5 integer scale was coarse. In `full-2`, all 8 baseline builds got overall 3, and 7 of 8 taste builds did too. The 0–10 scale replaces it; still use SSIM, the dimension scores, and `blind.html` alongside it.
- A reference build can look worse than the prompt-only builds when its layout breaks. In `full-2`, `client-detail-light` reference overlaps its own sidebar, so the judge gave it 2 even though its SSIM is high. No mode looks at its own render.
- One sample per cell is noisy. Use `--samples 3` or more before you trust a small difference.
