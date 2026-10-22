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

## 2. Plan minimal first, then add

Do this on every build, after you read the profile and before any code. Write the plan in your reply. Build from it. If you change the build, change the plan first.

1. **Base screen.** Write the smallest screen that does the job: the app shell, the page title, the one primary view, and each part the request names in its plainest form. Use the counts the request gives. Where it gives none, show only the one to three numbers or columns the task needs. Parts the request names are never extras; build all of them.
2. **Extras ledger.** List each extra you considered: a column, badge, filter, chart, sparkline, icon, accent, button, meta line, callout, or section. Mark each **add** or **skip**, with a short reason. Add an extra only when the task is weaker without it, or when a profile rule asks for it. "It looks richer" and "real products have it" are not reasons. Add one at a time, and look at the region again after each.
3. **Stop line.** Stop before the screen gets busy. Signs of busy: a row shows more than one kind of extra, two elements in a region compete for the first look, the same decoration repeats on every peer, or a part has columns the user does not need to decide. When in doubt, skip. Prefer more rows of the same kind over new columns or new kinds of element.

```
Base: shell, title, primary view = <view>, numbers = <the 1-3 the task needs>
+ add   sort on the date column: the user scans by recency
- skip  sparkline in each stat: it repeats the main chart
- skip  list of other items below: the request did not ask for it
```

Minimal is not empty. Keep the full shell, fill the primary view with enough real rows to fill its region, and give each region its one quiet surface. Calm comes from fewer kinds of element, not from less content.

## 3. Build with the rules

Apply hierarchy, spacing, density, typography, color, motion, and states from the rules, while honoring the existing app's components and conventions. Use references as illustrations of the rules; read [references/study-a-reference.md](references/study-a-reference.md) to extract what transfers. Prefer existing components over rebuilding identical primitives.

Precedence, highest first:

1. Current user request.
2. Existing project accessibility, interaction, and design constraints.
3. Confirmed project-specific preferences.
4. Confirmed personal preferences.
5. Related saved references (inspiration, not binding rules).

A user may love **one element** in a reference and dislike the rest. Never assume every visual detail is endorsed.

### Make a short prompt a real, calm product screen

A short prompt names the parts. You supply the product around them. Apply the rules inside a full screen; never meet a rule by removing content or structure, and never add content that makes the screen louder.

- **Frame.** Build the shell a shipped app has: side navigation (product mark, grouped links with icons, current page selected, account at the bottom) and a content area. Set the content area as one quiet surface on the page canvas, with a slim top line for location (breadcrumb or page name), a live status, and one or two actions. Keep the page title modest. Do not add a large hero title with a subtitle paragraph.
- **Scope.** Build every part the prompt names, in its order, with the counts it gives. Do not add whole sections, side panels, or columns it did not ask for. Add depth inside the named parts through the extras ledger: more rows first; a meta line, a legend, a sort, a totals line, or a pager only when it earns its place.
- **Volume.** Use specific, plausible data: names, IDs, dates, units, deltas. Give each list or table enough rows to fill its region, and each chart a full period. Size a chart to its panel. Leave no empty band, and balance side-by-side regions with content.
- **One surface level.** Each major region gets at most one quiet surface (a hairline border or a slight tint), and peers get the same treatment. Inside it, separate groups with space, type weight, and thin dividers. A row of stats is one strip with equal cells, not a box per stat inside a card. Tabs, filters, and toggles sit in the region's header line, not in a box of their own.
- **Modest type.** Use about four sizes and two weights. Key numbers are medium size and regular or medium weight; position and space make them lead. Use the faces the rules name. If the rules name none, use one neutral sans, with tabular figures for numbers and a mono only for IDs and code.
- **Quiet color.** Keep the canvas and surfaces neutral unless the rules ask for a tint. Use the one accent only for selection (active nav, active tab line, focus) and the data the user should look at first. The primary action is a neutral solid or outlined button, not a filled accent block. Show status as a small dot or icon plus plain text, not as colored pills everywhere. In charts, use the fewest series colors the data needs.
- **No decoration for its own sake.** Do not add a sparkline, badge, banner, or icon to every item to make it look rich. Add a detail only where it carries data the part needs.
- **Real states.** Show the selected nav item, the active tab with counts, hover on rows and controls, and an empty state for filters with no result. Every control does something visible. Mark one likely next step inline with a small "Recommended" label, and confirm each action in place with a short status line that says what changed.

## 4. Check before done

Before saying the work is finished, follow [references/review-implementation.md](references/review-implementation.md): look at the rendered UI if you can run a browser (if you cannot, do the read-back pass in that file), compare the page with your extras ledger, walk the profile area by area, mark each rule meets / misses / not applicable, fix the misses in scope, and report any rule you set aside and why. Do not claim a rule holds without evidence.

## 5. Learn without guessing

On an explicit like or dislike, hand it to **taste-add** to save, without asking the user for a reference ID. Don't turn silence or acceptance of your work into a preference.

`taste open` shows the local workspace when the user asks to browse. `taste gallery` exports a read-only HTML copy.
