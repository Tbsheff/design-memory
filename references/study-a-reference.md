# Study a reference — evidence before taste

Read this only when studying a saved reference or applying one to a UI.

## Extract the smallest transferable ideas

1. **Visual hierarchy** — What draws attention first and why? Contrast, scale, alignment, placement.
2. **Density & rhythm** — Compact vs airy, where the design spends space, how groups are separated.
3. **Typography** — Relative type scale, weight, leading, line lengths, not invented font names.
4. **Layout** — Column arrangement, sidebar/content split, alignment, sticky/fixed structures when verified.
5. **Components** — Table, dialog, tabs, select, nav, controls, states; distinguish shadcn primitives from design decisions.
6. **Color & treatment** — Surface hierarchy, borders, accent role, not guessed hex codes.
7. **Interaction** — Only call out animations, transitions, or behavior you actually observed, never infer them from a still image.
8. **Trade-off** — Which design goal benefited, and what cost (readability, scanning, mobile, discoverability) might follow?

Name each idea with a term from [aspects.md](aspects.md) so it lines up with the user's feedback.

## Describe it compactly

- **Observed:** A detail you can point to in the image/source.
- **Effect:** Why that detail matters for the task.
- **Transfer:** What to borrow for the current product.
- **Limit:** What may not carry over.

Bad: "Modern, premium, clean, intuitive UX."

Good: "The filter row shares one baseline and uses short control labels. This keeps the table's header visually dominant; useful for a dense worklist, but not proof that mobile filters work."

## Source types

- **shadcn component URL:** separate the component's behavior/API from a specific demo's visual styling. The user may like the interaction without liking its spacing or colors.
- **X post:** don't mistake descriptive text for a verified visual behavior. `taste add` stores the post text and images; preserve the URL when content is blocked.
- **Website link without a screenshot:** you have not seen it. Ask for a screenshot before describing it.

## Combine, don't copy

For mixed references, synthesize: "take the hierarchy of A, the compact tables of B, and the animation restraint of C" rather than copying any one screenshot.
