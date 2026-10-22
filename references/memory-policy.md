# Memory contract

- **Reference**: a screenshot or link and optional user notes. Not approval.
- **Observation**: an agent-authored assertion about an inspected source, with concrete evidence and certainty. Not approval.
- **Feedback**: an explicit user reaction to an aspect, with source reference and optional verbatim quote. May be project-specific.
- **Preference**: a reusable rule promoted from resolved feedback or directly expressed durable user instructions. Sources are mandatory.
- **Retirement**: a new record invalidating a preference without deleting its history.

## Precedence

Current instructions > relevant project preferences > confirmed personal preferences > observations > reference notes.

A saved item can illustrate several conflicting choices: a user may like its navigation and dislike its color. Always qualify aspect. An unrelated brand guideline, one-off prototype choice, or compliance constraint must not become global personal taste.

## Learning process

1. Group feedback by the underlying design choice, not solely shared keywords. Name aspects with [aspects.md](aspects.md) so groups line up.
2. Find positive and negative examples, look for context and contradictions.
3. Propose one short, testable reusable rule with scope and exceptions.
4. Confirm it with the user unless they already explicitly asked you to remember it.
5. Save the preference with evidence IDs and an `--area`; leave anything unresolved as a candidate.
6. When the user changes their mind, retire and replace, never silently reinterpret old feedback.

The executable CLI does not run models. Learning is agent-assisted and user-confirmed. This prevents random attractive screenshots from overwriting an established profile.

## Private/local data

The CLI never fetches remote URLs. The saved image bytes, original URLs, direct quotes, notes and project names live under `~/.design-memory`. Do not commit the directory or sync it to cloud storage without an explicit user decision. The local `gallery.html` displays the references from disk and contains no remote scripts or tracking.
