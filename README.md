# Perch Task Board — Thunderbird extension

A task manager that lives inside Thunderbird:

- **Status board** with four columns — **Urgent / High / Medium / Low** —
  and **drag-and-drop**: drag a card inside a column to reorder it, drag it
  into another column to change its status. Order is persisted per status.
- **Repeating tasks** — pick **Daily / Weekly / Monthly / Yearly** in the
  editor (or **Never**, the default). A repeating task is never "finished":
  ticking it off **moves it to its next occurrence** and leaves it on the
  board, with its reminder re-armed. Cadence is anchored to the original date,
  so a task due on the 31st stays on the 31st (clamping to 28/29 February in
  short months instead of drifting), and a long-overdue task jumps straight to
  the next future date rather than one step at a time. Cards show a
  🔁 *Daily/Weekly/…* chip, and repeats are published to the calendar as an
  RFC 5545 `RRULE`.
- **Due dates** — every task can carry a due date plus an optional time.
  A due reminder is announced on **two channels at once**: an **OS
  notification** (`notifications` API — the Windows toast / action-center
  entry) and a **reminder popup window inside Thunderbird**
  (`reminder.html`), showing the task, its due time, repeat, notes and the
  email it came from, with *Dismiss* and *Open board* buttons. Only one
  reminder window is kept open — a second reminder re-points it instead of
  stacking windows. Missed reminders (Thunderbird was closed when the task
  came due) fire once as an **Overdue** catch-up on the next sync. The toolbar
  button shows an **overdue count badge**.
- **Tasks from emails** — right-click any message (or a selection) in the
  message list → **Add to Perch**. The task keeps the subject, sender
  and date, and links back to the email: *Open email* from the task editor
  re-opens the original message (verified by Message-ID so a stale id can
  never open the wrong email).
- **Quick panel** — the toolbar popup shows everything due in the next
  7 days grouped by *Overdue / Today / Tomorrow / …*, lets you quick-add a
  task, and creates a task from the email you're currently reading.
- **Today panel** — a strip above the board listing everything **overdue or
  due today**, regardless of status, oldest first. Each row has a done
  checkbox (ticks it off without opening the editor), the status dot, the
  title (click to open the editor), the due-time chip, and the email chip
  when the task came from a message. Empty state: "Nothing due today 🎉".
- **Notes** — a **Notes** strip under the board keeps task-shaped entries
  you want to *keep for later*: jot a title in the box and press **Enter**
  for instant capture, or use **New note** for the full editor (title +
  text — the same dialog as a task, minus status/due/date). Notes live
  under their own `notes` storage key, so they never count towards the
  summary/Today panel and are **never published to the calendar**. They
  reorder by drag, show an *edited* timestamp, and delete behind a
  two-click confirm (from the card or the dialog).
- **Calendar** — export any due date as an `.ics` event file
  (Calendar button in the editor), **or publish the whole board** as a
  subscribable calendar (see *Show tasks in Thunderbird's Today Pane*
  below). *Why a file?* Thunderbird exposes **no
  supported WebExtension calendar API** (no `browser.calendars`), so an
  `.ics` you can drag into Thunderbird's Calendar (or double-click to
  import) is the reliable, version-proof integration. See
  [supported WebExtension APIs](https://developer.thunderbird.net/add-ons/mailextensions/supported-webextension-api).
- **Done strip** — the checkbox on a card moves it to the collapsible
  *Done* strip at the bottom; uncheck to restore. *Clear done* empties it.
- Per-column **⇅ sort** reorders that column by due date (unscheduled
  last); you can drag again any time afterwards.

## Install

**Temporary (development — resets when Thunderbird restarts):**

1. Thunderbird → menu → **Add-ons and Themes** (or `Ctrl+Shift+A`)
2. gear icon → **Debug Add-ons** → **Load Temporary Add-on…**
3. Pick `thunderbird_tasks/manifest.json`

**Permanent (no developer mode):** install the ready-made package
`perch-task-board-1.4.1.xpi` in this folder:

1. Thunderbird → menu → **Add-ons and Themes** (or `Ctrl+Shift+A`)
2. gear icon → **Install Add-on From File…** → pick `perch-task-board-1.4.1.xpi`
3. Confirm **Add** — it stays installed across restarts

(Or just drag the `.xpi` onto the Add-ons manager tab.) Unlike Firefox,
Thunderbird does not require add-ons to be signed by Mozilla, so this
unsigned package installs directly. If your build ever refuses it anyway,
set `xpinstall.signatures.required` to `false` in `Settings → General →
Config Editor…`, or sign it via
[addons.thunderbird.net](https://addons.thunderbird.net/).

**Rebuild the .xpi** after changing files:

```bash
cd thunderbird_tasks
python build_xpi.py
```

This writes `perch-task-board-<version>.xpi` for the Perch ID. To update the
older Task Board add-on in place so it gains the JSON export button without
losing its stored tasks, build and install a one-time migration package:

```bash
python build_xpi.py --legacy-id
```

Install `task-board-migration-<version>.xpi` from Add-ons and Themes → gear →
Install Add-on From File. It keeps the old ID `task-board@example.com` (so
Thunderbird updates that add-on's storage in place) but is labelled **Task
Board Data Transfer** to avoid confusing it with Perch. Open that board,
export JSON, then open Perch and import the backup. Once you have confirmed
the data transferred, you can remove the migration add-on if desired.

Both builds use an explicit file list — `manifest.json`, `storage.js`,
`background.js`, `dev_shim.js`, `board.html/css/js`, `reminder.html/css/js`,
`popup.html/css/js`, `icons/icon.svg` — and verify archive integrity,
manifest-at-root, JS syntax with `node --check`, and local HTML references.
`README.md`, `build_xpi.py` and editor cruft never ship.

## GitHub Releases

This directory is a standalone Git repository. To publish it under your
GitHub account:

1. Create an empty repository on GitHub (for example `perch-task-board`). Do
   not initialize it with a README, license, or `.gitignore`.
2. From this directory, make the initial commit and connect/push it:

```bash
git add .
git commit -m "Prepare Perch Task Board for GitHub releases"
git remote add origin https://github.com/atrus5/<repository>.git
git push -u origin main
```

Replace `<repository>` with the actual repository name. The included
`.github/workflows/release.yml` builds the Perch XPI and attaches it to a
GitHub Release whenever you push a version tag matching the manifest. The
tag must exactly match the version in `manifest.json`, prefixed with `v`:

```bash
# After changing manifest.json to the next version and committing the changes
git tag v1.4.2
git push origin v1.4.2
```

For each later release, use the new version (for example `v1.4.2`) and push
that tag. The workflow checks the version, runs `python build_xpi.py`, and
publishes `perch-task-board-<version>.xpi` with generated release notes. It
also has a manual **Run workflow** option that only builds and validates the
XPI; it does not publish a release without a version tag. GitHub Releases
are separate from submission to addons.thunderbird.net.

**Name and add-on ID:** this publishes as **Perch Task Board**, with the ID
`punitivepuns@proton.me`. An add-on ID **cannot be changed after the first
upload** to [addons.thunderbird.net](https://addons.thunderbird.net/), and it
is **public** — it sits in the manifest of every `.xpi` and can appear on the
listing — so it should be an address you're happy to have exposed. The feed
file below stays `task-board.ics` on purpose: it is a local file name and URL
you may already have subscribed to in Thunderbird.

Requires Thunderbird **115+** (`strict_min_version`); uses only supported
MailExtension APIs (`menus`, `messages`, `messageDisplay`, `alarms`,
`notifications`, `windows`, `storage`, `tabs`).

## Transfer tasks and notes between add-on IDs

Use this when moving data between the older **Task Board** install and **Perch Task Board**:

1. From the `thunderbird_tasks` source folder, run `python build_xpi.py --legacy-id` and install the resulting `task-board-migration-<version>.xpi`. Because it retains the old add-on ID, Thunderbird updates the existing Task Board install and preserves its stored tasks/notes.
2. Open the board labelled **Task Board Data Transfer**, choose **Export JSON**, and save the downloaded `perch-task-board-backup-YYYY-MM-DD.json` somewhere accessible.
3. Open the Perch Task Board board, choose **Import JSON**, and select that file.
3. The importer merges tasks and notes by record ID. Existing destination entries are kept; only missing records are added. Re-importing the same backup is safe. Imported dated tasks have their reminders rescheduled.
4. Check the new board for the transferred tasks and notes before uninstalling the old add-on.

The JSON backup includes all task and note fields, including completed tasks, repeat cadence, ordering, linked-email metadata, timestamps and reminder-deduplication state. Treat the file as private: linked task email subjects and senders may be included. Keep the old add-on installed until you have confirmed the import succeeded.

## Permissions (and why)

| Permission       | Used for                                                     |
|------------------|--------------------------------------------------------------|
| `menus`          | the “Add to Perch” message-list context menu            |
| `messagesRead`   | read selected/displayed message headers for task creation    |
| `storage`        | the task list (`storage.local`)                              |
| `alarms`         | schedule due-date reminders                                  |
| `notifications`  | the OS notification (Windows toast) shown with each reminder |
| `tabs`           | reopen/focus the board tab instead of opening duplicates     |
| `http://127.0.0.1:8899/*` (and `localhost`) | POST the published `task-board.ics` to the local `ics_server.py` feed |

## Files

| File            | Role                                                            |
|-----------------|-----------------------------------------------------------------|
| `manifest.json` | MV2 manifest (matches the other `thunderbird_*` extensions here) |
| `storage.js`    | shared model: task schema, load/save, due-date math, `.ics`, email deep-link |
| `background.js` | context menu, reminder alarms → OS notification **+ in-app popup window**, overdue badge, board-tab management |
| `board.html/css/js` | the board: columns, drag-and-drop, Today panel, **Notes strip**, editor dialog (incl. **Repeat**), done strip, **Publish calendar** |
| `reminder.html/css/js` | the **reminder popup window** opened by `background.js` when a task is due: title, due time, repeat, notes, *Dismiss* / *Open board* |
| `popup.html/css/js`  | toolbar popup: due-soon list, quick add, task from current email |
| `ics_server.py`  | stdlib-only local server that serves/publishes `task-board.ics` for Thunderbird's calendar subscription (run separately; not packaged in the `.xpi`) |
| `icons/icon.svg`| extension icon                                                 |
| `dev_shim.js`   | **not loaded in Thunderbird** — a `localStorage` stand-in for `browser.*` so the pages can be opened in a plain browser for UI work |

### Data

Tasks live in `browser.storage.local` under the `tasks` key as a single
array; a column renders the non-done tasks with that `status` **in array
order**, so array order *is* the manual order. Task shape:

```json
{
  "id": "uuid",
  "title": "Reply to invoice #1234",
  "notes": "",
  "status": "urgent",            // urgent | high | medium | low
  "due": "2026-10-22",           // YYYY-MM-DD or null
  "dueTime": "09:00",            // HH:MM or null (null => remind 09:00 that day)
  "repeat": "none",              // none | daily | weekly | monthly | yearly
                                  // (a repeat needs a due date; else forced to none)
  "done": false, "doneAt": null,
  "createdAt": "…", "notifiedAt": null,   // reminder dedupe; reset when due changes
  "email": { "messageId": 7, "headerMessageId": "<…>", "subject": "…",
             "author": "…", "date": "…", "folder": { … } }
}
```

Notes live separately under the `notes` key as a single array — same
last-writer-wins storage, but a schema with no status, due date or done
flag, which is why nothing but the Notes strip ever reads them:

```json
{
  "id": "uuid",
  "title": "Wifi password for the cottage",
  "text": "…",
  "createdAt": "…",
  "updatedAt": "…|null"      // set when edited; drives the "edited" chip
}
```

Array order *is* the displayed order; a new note is unshifted to the top
and can be dragged anywhere afterwards.

Reminder semantics: one announcement per due value, on both channels — the
OS notification and the in-app popup window. A task due in the past fires
immediately on the next sync (labelled *Overdue*, unless it's a date-only
task still due that day). Editing the due date re-arms the reminder.
Reminders older than 7 days are silently marked handled instead of nagging.
Resync passes are serialized, so a startup pass and a page write landing
together cannot announce the same task twice.

Repeat semantics: ticking a repeating task off is an **advance**, not a
completion — `due` moves to the next occurrence (strictly after today),
`notifiedAt` is cleared so the new occurrence gets its own reminder, and the
task stays on the board. Set **Repeat → Never** to make it a one-shot task
again. Repeats export to `.ics` as `RRULE:FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`.

## Show tasks in Thunderbird's Today Pane (subscribable calendar)

The board's **Publish calendar** button mirrors every dated, open task as a
**VTODO** in `task-board.ics`. Thunderbird has no calendar API for
extensions, but it *can subscribe to an ICS feed over HTTP* — so a tiny
local server makes your board tasks show up in Thunderbird's **Tasks list /
Today Pane** next to real events.

**One-time setup:**

1. Start the feed server (stdlib-only, no dependencies):

   ```bash
   cd thunderbird_tasks
   python ics_server.py            # serves http://127.0.0.1:8899/task-board.ics
   ```

2. In Thunderbird: **Calendar** tab → **Add Calendar** → **On My Network**
   → Location: `http://127.0.0.1:8899/task-board.ics` → name it
   *Perch Task Board*.

**Daily use:** open the board and click **Publish calendar**. Your tasks
appear in Thunderbird on its next refresh (or right-click the calendar →
**Refresh**). Stop/start the server any time; Thunderbird just shows the
last data it fetched.

**Semantics (by design — one-way mirror):**

- Only **dated, not-done** tasks are published. Tick one off on the board
  and it disappears from Thunderbird on the next publish/refresh.
- The board stays the single source of truth; ticking a task done *inside
  Thunderbird* does **not** write back to the board.
- `DUE` is floating local time (timed tasks) or all-day (`VALUE=DATE`), so
  the wall-clock time you set on the board is preserved. `PRIORITY` maps
  Urgent/High/Medium/Low → 1/3/5/7; `CATEGORIES` carries the status label.
- No server running? The button falls back to downloading `task-board.ics`
  so you can import it manually instead.

The server binds to `127.0.0.1` only and stores the calendar next to itself
(`--dir` to change, `--port` to move off 8899 — update the manifest
permission if you do).

## Local UI preview (no Thunderbird needed)

```bash
cd thunderbird_tasks
python -m http.server 8931 --bind 127.0.0.1
# open http://127.0.0.1:8931/board.html
#      http://127.0.0.1:8931/popup.html
#      http://127.0.0.1:8931/reminder.html?id=<a task id>   (the reminder window)
```

With no extension runtime, the pages load `dev_shim.js` (localStorage
storage, canned displayed-message, console notifications). This is how the
board was functionally tested: column reorder, cross-column moves, due-date
sort, editor save, done/restore, delete, `.ics` output, popup quick-add and
create-from-email all run against the shim.

## License

MIT — see [`LICENSE`](LICENSE).

Submission material for [addons.thunderbird.net](https://addons.thunderbird.net/)
— listing copy, privacy policy, reviewer notes and the 128×128 icon — lives in
[`listing/atn-listing.md`](listing/atn-listing.md) and
[`icons/icon-128.png`](icons/icon-128.png).
