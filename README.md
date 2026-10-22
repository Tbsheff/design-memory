# Taste — a local design memory

Save screenshots, website links, shadcn components, and X posts. Keep notes on what you like; use those references when building UI. No browser extension, embedding model, external database, or third-party npm packages.

**v0.5:** two agent skills + one Bun runtime + a new on-demand visual workspace.

## Install

Install [Bun](https://bun.com/docs/installation), then:

```bash
unzip design-memory-bun-ux.zip
cd design-memory-bun
bash install.sh
```

Open the workspace:

```bash
~/.agents/skills/design-memory/scripts/taste open
# or `taste open` when ~/.local/bin is on your PATH
```

The command opens a local browser page at an ephemeral **127.0.0.1** port. Close with **Ctrl+C** in the terminal; there is no background process when closed. To print the address without launching your default browser, run `taste open --browser no`.

### Desktop app (macOS)

`install.sh` also builds `~/Applications/Taste.app` when Swift is available (`xcode-select --install`). It is a native window around the same workspace, with a Dock icon, ⌘R to reload, and ⌘⇧B to open the workspace in your browser. If the background service runs, the app uses it. If not, the app starts its own server and stops it when you quit. Closing the window keeps the app in the Dock; quit with ⌘Q. Rebuild it on its own with `bash ~/.agents/skills/design-memory/desktop/build.sh`.

### Background service (macOS, optional)

```bash
taste service install            # start now and at every login, on http://127.0.0.1:4781
taste service status
taste service restart
taste service uninstall
```

The service is a launchd agent (`~/Library/LaunchAgents/dev.taste.workspace.plist`). launchd restarts it if it stops. While it runs, `taste open` only opens your browser to it. Logs go to `~/.design-memory/logs/service.log`. It uses about 30–60 MB of RAM while it runs. Use `--port N` with `install` to pick another port. The server answers only requests addressed to `127.0.0.1:<port>`, so other websites cannot read your library.

### In the workspace

- **Add:** click **Add reference** or press **N**. Paste multiple URLs, drop screenshots, select files, or paste an image from your clipboard. Add an optional note and project.
- **Find:** search all saved titles, notes, tags, feedback and observations. Press **/** to focus search. Filter by screenshots, sites, shadcn or X posts; browse 24 results per page.
- **Inspect:** select a card to see the original, add notes or record *what specifically* you like/dislike. Copy a ready-to-use reference prompt into your coding agent.
- **Learn:** open **My taste** to see and explicitly add/retire personal or project preferences. Copy your confirmed profile as a UI-building prompt.

A note or saved URL is **not automatically a lasting preference**. Feedback and confirmed preferences are separate. Websites are never fetched. X post links are the one exception: `taste add` reads the post's text and images from X's public embed endpoint (`cdn.syndication.twimg.com`) and stores them locally. Use `--fetch no` to save only the link. For private or deleted posts, or for sites, include a screenshot.

## Three agent skills

The installer creates independently discoverable skills:

- **`taste-add`** — use for screenshots, URLs, shadcn components, X posts, and explicit likes/dislikes. Say *"Save this. I like how dense this table is."* The agent saves the source and feedback.
- **`taste-define`** — use to work out your overall taste. Say *"Define my taste with me."* The agent looks at your saves, asks about qualities and feelings, and saves only the rules you pick, each with an area.
- **`taste-use`** — use when implementing or reviewing UI. Say *"Build the QA dashboard using my saved taste."* The agent retrieves the confirmed profile and a small set of relevant references, then checks the finished UI against each rule before it reports done.

The agent skills call **the same Bun CLI and the same SQLite library**, without running the visual workspace. Installation does not force preferences into every agent conversation.

## CLI (headless)

```bash
TASTE="$HOME/.agents/skills/design-memory/scripts/taste"
"$TASTE" add ~/Downloads/example.png --note 'Compact table rows'
"$TASTE" add https://ui.shadcn.com/docs/components/data-table
"$TASTE" add 'https://x.com/example/status/12345' --note 'Navigation pattern'
"$TASTE" search 'compact tables' --limit 8
"$TASTE" brief --topic 'settings page' --project bonaparte --limit 6
"$TASTE" profile --project bonaparte    # rules grouped by area
"$TASTE" area pref_ID layout            # set a rule's area
"$TASTE" open                         # editable visual UI, on-demand
"$TASTE" gallery                      # static read-only HTML export
```

Run `taste --help` for the rest of the CLI (observation/feedback/preference commands). Saving a screenshot from an agent requires that the agent can access the attachment as a local file.

## Local data, migrations, and RAM

```text
~/.agents/skills/
  taste-add/SKILL.md          # save / annotate instructions
  taste-define/SKILL.md       # taste interview / rules from reactions
  taste-use/SKILL.md          # retrieval / UI critique instructions
  design-memory/             # shared runtime; no active SKILL.md
    scripts/taste
    src/

~/.claude/skills/taste-add → ~/.agents/skills/taste-add
~/.claude/skills/taste-define → ~/.agents/skills/taste-define
~/.claude/skills/taste-use → ~/.agents/skills/taste-use

~/.design-memory/
  library.sqlite3            # one SQLite database
  media/                     # original images, content deduplicated
  thumbs/                    # small previews when sips/magick is available
  gallery.html               # optional static export
```

- **Idle:** 0 MB, no server, background sync, or embedding model — unless you install the optional background service (about 25 MB).
- **CLI:** Bun starts and exits after each operation; SQLite cache target is ~1 MiB.
- **Visual workspace:** Bun only runs while `taste open` is open. Search/paging is server-side, 24 references at a time; thumbnail images are lazy-loaded. Uploaded images stream through a bounded pipeline, hash as they arrive, and are moved into the library without an additional copy.
- **Privacy:** localhost `127.0.0.1` binding, random session token for writes, no CORS access, no remote resources in the UI. It is a personal workstation tool, not a multi-user service.
- **Existing libraries:** installer preserves `~/.design-memory`; older JSON libraries automatically migrate to SQLite. It archives the old combined skill (if present) rather than deleting user data.

Bun RSS depends on the installed version and platform. Browser RAM depends on viewed images. **Native Bun RAM testing is still needed**; the available environment did not include Bun.

## Verify

```bash
bash -n install.sh
bun test
```

The test suite covers the CLI, deduplication, legacy import, search, preferences and the on-demand web API. The visual UI has been checked in Chromium (desktop/mobile) using a mocked backend. API compatibility checks were run with Node's SQLite adapter, not the native Bun runtime.

## Credits

Independent MIT implementation informed by Incline, Tastemaker, Taste Vault, Taste DNA and Curio. See `LICENSE`.
