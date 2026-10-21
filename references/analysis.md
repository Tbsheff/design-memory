# Design interpretation — evidence before taste

Read this only when studying a reference or applying one to a UI.

## Extract the smallest transferable ideas

1. **Visual hierarchy** — What draws attention first and why? Contrast, scale, alignment, placement.
2. **Density & rhythm** — Compact vs airy, where the design spends space, how groups are separated.
3. **Typography** — Relative type scale, weight, leading, line lengths, not invented font names.
4. **Layout** — Column arrangement, sidebar/content split, alignment, sticky/fixed structures when verified.
5. **Components** — Table, dialog, tabs, select, nav, controls, states; distinguish shadcn primitives from design decisions.
6. **Color & treatment** — Surface hierarchy, borders, accent role, not guessed hex codes.
7. **Interaction** — Only call out animations, transitions, or behavior you actually observed, never infer them from a still image.
8. **Trade-off** — Which design goal benefited, and what cost (readability, scanning, mobile, discoverability) might follow?

Use this compact description format:

- **Observed:** A detail you can point to in the image/source.
- **Effect:** Why that detail matters for the task.
- **Transfer:** What to borrow for the current product.
- **Limit:** What may not carry over.

Bad: "Modern, premium, clean, intuitive UX."

Good: "The filter row shares one baseline and uses short control labels. This keeps the table's header visually dominant; useful for a dense worklist, but not proof that mobile filters work."

For a shadcn component URL, separate **the component's behavior/API** from **a specific demo's visual styling**. The user may like the interaction without liking its spacing or colors. For an X post, don't mistake descriptive text for a verified visual behavior; preserve the URL when content is blocked.

For mixed references, synthesize: "take the hierarchy of A, the compact tables of B, and the animation restraint of C" rather than copying any one screenshot.

## Review the implementation

1. Compare the screenshot of the real implementation with the source reference and the user's current constraints.
2. Flag up to five concrete mismatches, sorted by impact.
3. Include loading, error, empty, narrow-screen, and keyboard states if the scope calls for them.
4. Ask about the one most consequential uncertain aspect. Record only the answer given.
5. Never turn the agent's own aesthetic judgment into a user preference.
