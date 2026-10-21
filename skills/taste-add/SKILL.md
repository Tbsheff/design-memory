---
name: taste-add
description: Save visual UI inspiration and explicit design feedback. Activate when a user drops a screenshot, website, shadcn component, or X post as inspiration; says save/remember/add this design; or says what they like/dislike about UI. Use taste-use for building from previously saved designs.
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

## 3. Lasting preferences require user approval

A note or observation is not a global rule. If the user explicitly says *"Always use compact tables"* or confirms a proposed rule, save that preference with the exact statement or linked explicit feedback:

```bash
<skill-directory>/scripts/taste prefer --kind prefer --rule 'Compact tables with readable grouping' --statement 'User: always use compact tables'
<skill-directory>/scripts/taste prefer --kind avoid --rule 'Avoid nested cards' --statement 'User: avoid nested cards'
```

Read `references/memory-policy.md` for scopes, contradictions, retirement and evidence. Don't silently promote patterns from repeated saves or the absence of criticism. On repeats, `taste candidates` can suggest a rule **for confirmation**.

## 4. Small, useful acknowledgement

After a save, confirm **what was stored** and mention one useful explicit note, if supplied. Don't dump metadata or suggest browser capture. A saved link is not proof you inspected it.
