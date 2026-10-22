---
name: taste-add
description: Save visual UI inspiration and explicit design feedback, and define the user's design taste with them. Activate when a user drops a screenshot, website, shadcn component, or X post as inspiration; says save/remember/add this design; says what they like/dislike about UI; or asks to define their taste or review their uploads. Use taste-use for building from previously saved designs.
license: MIT
compatibility: Bun 1.3+, local SQLite; no embeddings, external APIs, or resident process.
---

# Taste Add

The user should be able to **throw references at you** without filling out forms or remembering command syntax. Use the shared CLI at `<skill-directory>/scripts/taste` and keep data in `~/.design-memory` (`DESIGN_MEMORY_HOME` override).

## 1. Save first, ask only if blocked

- Screenshots: save the **original attached image** as a local file (using the agent's attachment capability), then `taste add /path/to/image.png`. Never claim a screenshot was saved if the file cannot be accessed.
- URLs: `taste add URL` works for websites, shadcn components, and X posts. No browser extension or capture automation needed.
- X posts: `taste add` saves the post text and downloads its images automatically. If the output has `warnings`, the post was not readable; ask for a screenshot and attach it with `--image`.
- Multiple references: pass several URLs/files to one `taste add` call.
- Preserve the user's exact description as `--note`; keep any explicit project scope with `--project`.
- If the user explicitly asks for a visual inbox, run `taste open` **in a user-visible terminal**. Otherwise prefer the headless CLI and don't open a browser on every save.

```bash
<skill-directory>/scripts/taste add /path/to/image.png --note "Like the compact table rows"
<skill-directory>/scripts/taste add https://ui.shadcn.com/docs/components/data-table
<skill-directory>/scripts/taste add 'https://x.com/example/status/12345' --note "Navigation"
<skill-directory>/scripts/taste add https://example.com --image /path/to/screenshot.png --project dashboard
```

A URL is initially a saved **link**, not a screenshot. If the visual is inaccessible, explain that a screenshot is required. Don't invent content of unviewed links or posts.

## 2. Analyze without over-interpreting

Read `references/analysis.md` only if you are analyzing the visual, not on every save. Distinguish observations about a design from user judgments:

```bash
<skill-directory>/scripts/taste observe ref_ID --aspect 'table density' --detail 'Tight rows, clear groups' --evidence 'Image rows 1–8'
<skill-directory>/scripts/taste feedback ref_ID --vote like --aspect 'table density' --quote 'I like the dense tables'
```

A saved item isn't blanket approval. A user saying *"I like the table but hate the tabs"* is feedback on **two aspects**, not an overall vote.

## 3. Taste reviews: ask about qualities, not parts

When the user asks to define their taste or review their uploads, the goal is **why** they like things, not **what** is on the screen. Asking them to rate a timeline grid, a popover, or status pills records screen contents, not taste.

1. Look at every saved visual first (`taste list`, then the local media files). Note what they share; don't present a per-screenshot checklist.
2. Ask cross-cutting questions about qualities, feelings, and values, with the saved set as context:
   - **The pull:** what draws them to these (calm restraint, a lot made clear, software that explains itself, obsessive craft).
   - **Feeling:** what using their product should feel like (precise instrument, calm assistant, sharp workspace, warm and human).
   - **Personality:** how much identity should show (almost invisible to bold and expressive).
   - **Turn-offs:** what makes a design feel wrong (decoration, generic template, hidden logic, clutter).
3. Probe tensions in their answers. *"Warm and human"* plus *"no decoration"* means asking where warmth comes from instead (words, warm neutrals, soft shapes, people in the UI).
4. Propose short, testable rules in plain language, a few at a time, and save **only** the ones they pick. Unpicked options are not dislikes; don't save them as `avoid`.

Ask about a specific screen part only when the user points at it (*"I love this table"*); then record it as aspect-level feedback (section 2).

## 4. Lasting preferences require user approval

A note or observation is not a global rule. If the user explicitly says *"Always use compact tables"* or confirms a proposed rule, save that preference with the exact statement or linked explicit feedback:

```bash
<skill-directory>/scripts/taste prefer --kind prefer --rule 'Compact tables with readable grouping' --statement 'User: always use compact tables'
<skill-directory>/scripts/taste prefer --kind avoid --rule 'Avoid nested cards' --statement 'User: avoid nested cards'
```

Read `references/memory-policy.md` for scopes, contradictions, retirement and evidence. Don't silently promote patterns from repeated saves or the absence of criticism. On repeats, `taste candidates` can suggest a rule **for confirmation**.

## 5. Small, useful acknowledgement

After a save, confirm **what was stored** and mention one useful explicit note, if supplied. Don't dump metadata or suggest browser capture. A saved link is not proof you inspected it.
