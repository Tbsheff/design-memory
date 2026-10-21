---
name: taste-use
description: Retrieve a person's confirmed design preferences and relevant saved screenshots, websites, shadcn components, and X posts when building, redesigning, or reviewing a user interface. Activate for requests to use the user's taste/design inspiration or review UI against saved preferences; use taste-add when only saving references.
license: MIT
compatibility: Bun 1.3+, local SQLite; no embeddings, external APIs, or resident process.
---

# Taste Use

Use the shared CLI at `<skill-directory>/scripts/taste`. **Don't start the browser** just to generate a UI: retrieval works headlessly and loads only what the task needs.

## Retrieve enough, not everything

1. Identify the UI being built or reviewed, plus any project scope the user specified.
2. Retrieve *confirmed preferences* and a short topic-relevant brief. Limit references to **5–8**, never the whole gallery.
3. Open original screenshots/links **only** for the examples whose visuals materially matter. The saved URL by itself doesn't prove you saw the current site.
4. Synthesize an implementation: apply hierarchy, spacing, density, visual rhythm, typography, states, and components while honoring the existing app conventions.

```bash
<skill-directory>/scripts/taste profile --project bonaparte
<skill-directory>/scripts/taste brief --project bonaparte --topic 'QA review dashboard' --limit 6
<skill-directory>/scripts/taste show ref_ID
```

To browse interactively at the user's request, `taste open` shows the on-demand local workspace. `taste gallery` exports a separate read-only HTML copy.

## Source-of-truth precedence

1. Current user request.
2. Existing project accessibility/interaction/design constraints.
3. Confirmed project-specific preferences.
4. Confirmed personal preferences.
5. Related saved references (inspiration, not binding rules).

A user may love **one element** in a reference and dislike the rest. Never assume every visual detail is endorsed. Prefer existing components over rebuilding identical primitives. Don't claim a screenshot proves an inaccessible site's current appearance.

## Review / iterate

Use `references/analysis.md` for substantive critique. Show what matches the user's choices, what conflicts, and what would change. On an explicit like/dislike, hand it to **taste-add** to save, without asking the user to supply a reference ID. Don't turn silence or implementation acceptance into a lasting preference.

## Keep it efficient

No embeddings, no image-database scans, and no browser server for typical coding tasks. SQLite search is indexed and gallery thumbnails load only on demand. Stop once the relevant evidence is sufficient.
