# Review an implementation against the user's taste

Read this before calling UI work done, or when the user asks for a review.

## Check before done

1. Run `taste profile` (add `--project NAME` when scoped). Rules are grouped by area.
2. If you can run a browser, look at the real rendered UI, not only the code: a screenshot, the running app, or a browser preview. If you cannot, do the read-back pass below; it is your only evidence.
3. Walk the profile one area at a time. For each rule, decide: **meets**, **misses**, or **not applicable**. Do not skip an area because it "probably" holds.
4. Fix every **miss** that is in scope. If a rule conflicts with the current request or a project constraint, the request wins; say which rule you set aside and why.
5. Include loading, error, empty, narrow-screen, and keyboard states when the scope calls for them.

## Read-back pass (no browser)

Read the HTML and CSS again from the top, as if you see the page at a desktop width. Check each item and fix what fails:

- **Shell.** Navigation, location line, status, and actions are present. The current page is selected.
- **Scope.** Every named part is there, in order. Nothing extra sits beside it. Remove an added section rather than shrink a named one.
- **Calm.** Each element outside the base screen is in your extras ledger as **add**. Remove any extra that is not, and any skipped extra that crept in. Count the kinds of extra in one row and in one region; if two compete for the first look, remove the weaker one. Never remove a named part to get calm.
- **Fill.** Each region has enough rows or points for its height. No panel has a large empty area under its content.
- **Surfaces.** Count the bordered or tinted layers from the page to each element. More than one inside the content surface is a box in a box.
- **Type.** List the font sizes and weights the CSS uses. Merge near values until about four sizes remain.
- **Spacing.** List the gap and padding values. Snap odd values to one small scale. The gap between groups is larger than the gap inside a group, also between a header and the content it labels.
- **Color.** Find every use of the accent. Each one marks selection, focus, or the data to look at first. Turn any other use neutral.
- **Fit.** Labels, badges, buttons, and tags stay on one line. Long IDs and links can break. Columns are wide enough for their longest value.
- **Behavior.** Each control has a handler and a visible result.

Report in this shape, misses first:

| Area | Rule | Result | Evidence |
| --- | --- | --- | --- |
| Surfaces | Shadows for depth, borders for structure | Miss → fixed | Cards used 1px borders; now `--shadow-border` |

Rows marked not applicable can be grouped into one line.

## Compare with a reference

1. Compare the implementation with the source reference and the user's current constraints.
2. Flag up to five concrete mismatches, sorted by impact.
3. Ask about the one most consequential uncertain aspect. Record only the answer given, with `taste-add`.

## Boundaries

- Never turn your own aesthetic judgment into a user preference.
- A reference illustrates rules; it never overrides a confirmed rule.
- Acceptance of your work, or silence, is not a new preference.
