# Taste interview guide

Read this when defining the user's taste or turning their saved designs into rules.

## Ask about qualities, not parts

Taste is **why** the user likes something, not **what** is on the screen. Asking them to rate a timeline grid, a popover, or status pills records screen contents, not taste. Ask about a specific part only when the user points at it.

## Round 1: the pull and the feeling

Look at every saved visual first, then ask across the whole set (multi-select where it fits, four options each):

- **The pull:** what draws them to these — calm restraint, a lot made clear, software that explains itself, obsessive craft.
- **Feeling:** what using their product should feel like — a precise instrument, a calm assistant, a sharp workspace, warm and human.
- **Personality:** how much identity should show — almost invisible, a quiet signature, a clear brand voice, bold and expressive.
- **Turn-offs:** what makes a design feel wrong — decoration, a generic template, hidden logic, clutter.

Write options from what the saved designs actually show; the lists above are starting points.

## Round 2: settle the tensions

Look for answers that pull against each other and ask where the quality should come from:

| Tension | Ask |
| --- | --- |
| Warm and human + no decoration | Where does warmth come from: the words, warm neutrals, soft shapes, people in the UI? |
| Clear brand voice + calm restraint | Where does the brand live: one signature color, distinct type, voice in the copy, signature details? |
| Explains itself | How: say why, show the evidence, recommend a next step, say what changed? |
| Lots on screen + clear | What keeps it clear: one focus per view, hierarchy over boxes, progressive detail, color only for state? |

## Round 3: propose rules

- Write each rule as one testable sentence in plain words. "Feels premium" is not testable; "Organize with type size, weight, and space instead of more containers" is.
- Offer four rules per question, multi-select, with a short label and the full rule as the description.
- Save **only** the rules the user picks, each with an `--area` from [aspects.md](aspects.md). Unpicked options are not dislikes: never save them as `avoid`.
- Use `--kind avoid` only for a turn-off the user chose.

```bash
taste prefer --kind prefer --area layout --rule 'Organize with type size, weight, and space instead of more containers' --statement 'User confirmed in taste review: hierarchy over boxes'
```

## After the interview

- Summarize the rules saved and the ones left out, in one short list each.
- Don't re-ask a question the user answered in free text; treat their message as the answer.
