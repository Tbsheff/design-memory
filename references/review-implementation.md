# Review an implementation against the user's taste

Read this before calling UI work done, or when the user asks for a review.

## Check before done

1. Run `taste profile` (add `--project NAME` when scoped). Rules are grouped by area.
2. Look at the real rendered UI, not only the code: a screenshot, the running app, or a browser preview.
3. Walk the profile one area at a time. For each rule, decide: **meets**, **misses**, or **not applicable**. Do not skip an area because it "probably" holds.
4. Fix every **miss** that is in scope. If a rule conflicts with the current request or a project constraint, the request wins; say which rule you set aside and why.
5. Include loading, error, empty, narrow-screen, and keyboard states when the scope calls for them.

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
