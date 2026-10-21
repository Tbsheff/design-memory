# Example: two skills, one library

## taste-add: quick capture

User: "Save these screenshots. I like the compact table rows."

1. Save each image through `taste add`.
2. If specific feedback is present, record it with `taste feedback`.
3. Never assume the user also likes the colors or typography.

User: "Save https://ui.shadcn.com/docs/components/data-table."

1. `taste add <url>` without attempting screenshots or requiring metadata.

## taste-use: focused retrieval

User: "Build a QA dashboard using my taste."

1. `taste profile --project bonaparte`
2. `taste brief --project bonaparte --topic 'QA dashboard' --limit 8`
3. Inspect only the most relevant screenshots and apply the explicit rules.
4. If user gives explicit keep/reject feedback, hand it to taste-add for storage.
