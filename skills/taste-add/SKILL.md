---
name: taste-add
description: Save visual UI inspiration and quick design feedback. Activate when a user drops a screenshot, website, shadcn component, or X post as inspiration; says save/remember/add this design; or reacts to one specific design ("I like this table", "hate these tabs"). Use taste-define to work out their overall taste, taste-use to build from it.
license: MIT
compatibility: Bun 1.3+, local SQLite; no embeddings or external APIs.
---

# Taste Add

The user should be able to **throw references at you** without filling out forms or remembering command syntax. Use the shared CLI at `<skill-directory>/scripts/taste` and keep data in `~/.design-memory` (`DESIGN_MEMORY_HOME` override).

## 1. Save first, ask only if blocked

- Screenshots: save the **original attached image** as a local file (using the agent's attachment capability), then `taste add /path/to/image.png`. Never claim a screenshot was saved if the file cannot be accessed.
- URLs: `taste add URL` works for websites, shadcn components, and X posts. No browser extension or capture automation needed.
- X posts: `taste add` saves the post text and downloads its images automatically. If the output has `warnings`, the post was not readable; ask for a screenshot and attach it with `--image`.
- Multiple references: pass several URLs/files to one `taste add` call.
- Preserve the user's exact description as `--note`; keep any explicit project scope with `--project`.
- If the user explicitly asks for a visual inbox, run `taste open`. Otherwise prefer the headless CLI and don't open a browser on every save.

```bash
<skill-directory>/scripts/taste add /path/to/image.png --note "Like the compact table rows"
<skill-directory>/scripts/taste add https://ui.shadcn.com/docs/components/data-table
<skill-directory>/scripts/taste add 'https://x.com/example/status/12345' --note "Navigation"
<skill-directory>/scripts/taste add https://example.com --image /path/to/screenshot.png --project dashboard
```

A URL is initially a saved **link**, not a screenshot. If the visual is inaccessible, explain that a screenshot is required. Don't invent content of unviewed links or posts.

## 2. Record reactions per aspect

When the user reacts to a specific part of a design, save it as feedback on that aspect. Name the aspect with [references/aspects.md](references/aspects.md) so reactions to different references group together, and keep the user's words in `--quote`:

```bash
<skill-directory>/scripts/taste feedback ref_ID --vote like --aspect 'density' --quote 'I like the dense tables'
<skill-directory>/scripts/taste feedback ref_ID --vote dislike --aspect 'containers' --quote 'too many boxes'
```

*"I like the table but hate the tabs"* is two records, not one overall vote. A saved item isn't blanket approval.

Only when you analyze a visual, read [references/study-a-reference.md](references/study-a-reference.md) and record what you see as an observation, never as the user's opinion:

```bash
<skill-directory>/scripts/taste observe ref_ID --aspect 'density' --detail 'Tight rows, clear groups' --evidence 'Image rows 1–8'
```

## 3. Rules need the user's approval

A note, observation, or single reaction is not a rule. Save a preference only when the user states one ("always use compact tables") or confirms one you proposed, and give it an `--area`:

```bash
<skill-directory>/scripts/taste prefer --kind prefer --area layout --rule 'Compact tables with readable grouping' --statement 'User: always use compact tables'
```

To work out their taste from many saves, hand off to **taste-define**. Read [references/memory-policy.md](references/memory-policy.md) for scopes, contradictions, and retirement.

## 4. Small, useful acknowledgement

After a save, confirm **what was stored** and mention one useful explicit note, if supplied. Don't dump metadata or suggest browser capture. A saved link is not proof you inspected it.
