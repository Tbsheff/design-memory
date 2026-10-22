---
name: taste-define
description: Work out a person's design taste with them and turn it into confirmed rules. Activate when the user asks to define, discover, or refine their taste, review their saved designs or uploads, turn references into preferences, or clean up their taste profile. Use taste-add for single saves, taste-use to build from the profile.
license: MIT
compatibility: Bun 1.3+, local SQLite; no embeddings or external APIs.
---

# Taste Define

Turn saved designs and reactions into a short set of rules the user has confirmed. Use the shared CLI at `<skill-directory>/scripts/taste`.

## 1. Start from what exists

```bash
<skill-directory>/scripts/taste profile
<skill-directory>/scripts/taste list --limit 100
<skill-directory>/scripts/taste candidates
```

Look at every saved visual (the `media` paths under `~/.design-memory`) before asking anything. Note what the set shares. Skip links you cannot see, and say so.

## 2. Interview about qualities, not parts

Follow [references/taste-interview.md](references/taste-interview.md):

1. **Round 1** — ask across the whole set: what draws them, how the product should feel, how much personality shows, what turns them off.
2. **Round 2** — probe tensions in their answers and ask where each quality should come from.
3. **Round 3** — propose short, testable rules, four at a time, and let them pick.

Never ask them to rate parts of each screenshot. If they point at a specific part themselves, record it as aspect feedback with **taste-add**.

## 3. Use reactions that already exist

`taste candidates` lists reactions repeated across references. It groups only identical aspect names, so also scan feedback yourself and group by the design choice behind it, using [references/aspects.md](references/aspects.md). Propose each group as a rule; don't save it until the user confirms.

## 4. Save only what they pick

```bash
<skill-directory>/scripts/taste prefer --kind prefer --area layout --rule 'Organize with type size, weight, and space instead of more containers' --statement 'User confirmed in taste review: hierarchy over boxes'
<skill-directory>/scripts/taste prefer --kind avoid --area feel --rule 'The generic SaaS/AI template look' --statement 'User confirmed in taste review: never generic'
<skill-directory>/scripts/taste area pref_ID layout
```

- Every rule gets one `--area`: feel, layout, surfaces, type, color, motion, behavior, or writing.
- Unpicked options are not dislikes. Never save them as `avoid`.
- When a new rule contradicts an old one, ask which wins, then `taste retire` the loser. See [references/memory-policy.md](references/memory-policy.md).

## 5. Close the loop

List the rules saved and the ones left out, grouped by area, in a few lines. Point to `taste profile` or **My taste** in the workspace.
