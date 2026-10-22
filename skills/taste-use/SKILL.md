---
name: taste-use
description: Apply a person's confirmed design preferences and relevant saved references when building, redesigning, or reviewing a user interface, then check the result against them. Activate for requests to use the user's taste or design inspiration, or to review UI against their preferences. Use taste-add to save references, taste-define to work out taste.
license: MIT
compatibility: Bun 1.3+, local SQLite; no embeddings or external APIs.
---

# Taste Use

Use the shared CLI at `<skill-directory>/scripts/taste`. **Don't start the browser** just to generate a UI: retrieval works headlessly and loads only what the task needs.

## 1. Retrieve enough, not everything

1. Identify the UI being built or reviewed, plus any project scope the user specified.
2. Load the confirmed rules (grouped by area) and a short topic brief. Limit references to **5–8**, never the whole gallery.
3. Open original screenshots or links **only** for the examples whose visuals materially matter. A saved URL doesn't prove you saw the current site.

```bash
<skill-directory>/scripts/taste profile --project bonaparte
<skill-directory>/scripts/taste brief --project bonaparte --topic 'QA review dashboard' --limit 6
<skill-directory>/scripts/taste show ref_ID
```

## 2. Build with the rules

Apply hierarchy, spacing, density, typography, color, motion, and states from the rules, while honoring the existing app's components and conventions. Use references as illustrations of the rules; read [references/study-a-reference.md](references/study-a-reference.md) to extract what transfers. Prefer existing components over rebuilding identical primitives.

Precedence, highest first:

1. Current user request.
2. Existing project accessibility, interaction, and design constraints.
3. Confirmed project-specific preferences.
4. Confirmed personal preferences.
5. Related saved references (inspiration, not binding rules).

A user may love **one element** in a reference and dislike the rest. Never assume every visual detail is endorsed.

## 3. Check before done

Before saying the work is finished, follow [references/review-implementation.md](references/review-implementation.md): look at the real rendered UI, walk the profile area by area, mark each rule meets / misses / not applicable, fix the misses in scope, and report any rule you set aside and why. Do not claim a rule holds without looking.

## 4. Learn without guessing

On an explicit like or dislike, hand it to **taste-add** to save, without asking the user for a reference ID. Don't turn silence or acceptance of your work into a preference.

`taste open` shows the local workspace when the user asks to browse. `taste gallery` exports a read-only HTML copy.
