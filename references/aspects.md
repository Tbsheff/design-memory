# Shared aspect vocabulary

Use these names for the `--aspect` of observations and feedback, and pick the matching `--area` for preferences. `taste candidates` groups feedback only when the aspect text matches, so the same idea must always get the same name.

Use the closest existing term. Add a new term only when none fits, and reuse it from then on.

| Area | Aspects |
| --- | --- |
| feel | overall mood, personality, warmth, restraint, brand signature |
| layout | density, grouping, hierarchy, alignment, sidebar navigation, split panes, progressive disclosure, responsive behavior |
| surfaces | borders and shadows, corner radius, containers, image treatment, iconography |
| type | type scale, font choice, font weight, text wrapping, numerals |
| color | palette, accent use, status color, contrast, theme |
| motion | enter and exit motion, press feedback, motion restraint, loading states |
| behavior | explanations, recommendations, confirmations, empty states, error handling, keyboard support |
| writing | tone of voice, labels, error messages, microcopy |

## Naming rules

- Lowercase, two or three words, no punctuation: `status color`, not `Status colours!`.
- Name the design choice, not the screen part: `density` for "the rows are tight", `containers` for "too many boxes".
- One aspect per feedback record. *"Love the table, hate the tabs"* is two records.
- Put the user's own words in `--quote`; keep the aspect short and standard.
