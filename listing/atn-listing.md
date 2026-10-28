# Perch Task Board — addons.thunderbird.net submission sheet

Everything below is paste-ready. Fill ATN's form top to bottom with these values;
the description, privacy policy and reviewer notes are plain text (blank lines
separate paragraphs, `•` starts a bullet), which the listing renders as-is.

## 1. File to upload

`perch-task-board-1.4.1.xpi` — build it with `python build_xpi.py`. Unsigned is
fine: ATN signs during review.

## 2. Listing fields

| Field | Value |
|---|---|
| Name | `Perch Task Board` |
| Summary | see §3 (250-character limit) |
| Category | **Miscellaneous** (alternative: *Calendar and Date/Time*, if you want to sit next to calendar tools) |
| Tags | `task`, `todo`, `calendar`, `reminder`, `productivity` |
| License | **MIT** — [`LICENSE`](../LICENSE) |
| Homepage | **leave blank for now** — later `https://github.com/atrus5/<repo>` |
| Support site / issues | **leave blank for now** — later `https://github.com/atrus5/<repo>/issues` |
| Icon (128×128 PNG) | [`icons/icon-128.png`](../icons/icon-128.png) |
| Screenshots | [`screenshots/01-board-repeating-tasks.png`](../screenshots/01-board-repeating-tasks.png) (1750×1125), [`02-editor-repeat.png`](../screenshots/02-editor-repeat.png) (1750×1125), [`03-reminder-popup.png`](../screenshots/03-reminder-popup.png) (440×260), [`04-windows-toast-crop.png`](../screenshots/04-windows-toast-crop.png) (392×155) — upload in that order |
| Add-on ID | `punitivepuns@proton.me` — permanent after the first upload, and public |

## 3. Summary (paste)

```
A task board inside Thunderbird: four priority columns, due dates with popup and system reminders, repeating tasks, tasks created from email, and notes kept for later.
```

## 4. Description (paste)

```
Perch Task Board puts a task board inside Thunderbird, so the task that starts in your inbox never has to leave it.

• Four priority columns — Urgent, High, Medium and Low. Drag a card within a column to reorder it, or across to change its priority. The order sticks.

• Due dates and reminders — give any task a date and an optional time. When it comes due, Perch announces it twice: a popup window inside Thunderbird showing the task, its time, notes and the email it came from, plus a system notification (the Windows toast / action centre) that opens the board when clicked. If Thunderbird was closed when something came due, you get an "Overdue" catch-up on the next start. The toolbar button carries an overdue count badge.

• Repeating tasks — Daily, Weekly, Monthly or Yearly. Ticking a repeating task off moves it to its next occurrence instead of closing it, and the cadence stays anchored to the original date (a task due on the 31st stays on the 31st, clamping into shorter months without drifting). Repeats are exported to the calendar as standard recurrence rules.

• Tasks from email — right-click one or more messages → Add to Perch. The task keeps the subject, sender and date, and can open the original message again from its editor. The link is verified against the Message-ID, so a stale id can never open the wrong email.

• Everything else — a Today panel listing what is overdue or due today; a collapsible Done strip; a Notes area for things you want to keep rather than do; JSON backup and merge-import for moving tasks and notes between add-on installs; and calendar export: any single task as an .ics event, or the whole board published as a subscribable calendar so tasks appear in Thunderbird's Tasks list and Today Pane.

No account, no sync service, no telemetry. Your tasks are stored by Thunderbird on your own machine. JSON backups are created only when you choose Export JSON and remain wherever you save them.

Requires Thunderbird 115 or newer. Works on Windows, macOS and Linux.
```

## 5. Privacy policy (paste as full text, not a link)

```
Perch Task Board runs entirely inside Thunderbird and keeps everything on your computer.

What it stores: the tasks and notes you create, in Thunderbird's extension storage on your machine. If you choose Export JSON, the add-on downloads a backup file to the location chosen by Thunderbird; it may include linked email subjects and senders. Nothing is sent to the developer or to any third party.

Network access: the add-on has no remote server. Its only network request is an HTTP POST to 127.0.0.1:8899 (or localhost:8899) on your own computer, made only when you click "Publish calendar" and only if you have started the optional local feed server yourself. If that server is not running, no request is made and the calendar is offered as a file download instead.

Message data: when you choose "Add to Perch", the add-on reads the subject, sender, date and Message-ID of the message you selected so the task can link back to it. Message bodies are never read, stored, or transmitted.

No analytics, no tracking, no advertising, and no remote code: the add-on loads only the code packaged inside it.

Deleting your data: delete individual tasks or notes in the board, or uninstall the add-on — uninstalling removes its stored tasks and notes from Thunderbird. Any JSON backup or .ics file you exported or published stays wherever you saved it.

Privacy contact: punitivepuns@proton.me
```

## 6. Notes to reviewer (paste)

```
Thank you for reviewing. A few notes that should save you time:

Source: the .xpi is unminified and unbundled. It contains exactly the files the add-on loads (manifest.json, storage.js, background.js, board.html/css/js, popup.html/css/js, reminder.html/css/js, dev_shim.js, icons/icon.svg). There is no build step, no generated or obfuscated code, and no remote code loading.

dev_shim.js is a development helper: it defines a localStorage-backed stand-in for the browser API and is only used when the HTML pages are opened in a plain browser without an extension runtime. Inside Thunderbird the browser object exists, so the shim script tag is skipped entirely.

Permissions, and why each is needed:
• storage — tasks and notes in storage.local.
• downloads (implicit) — download a JSON backup selected by the user.
• menus — the single "Add to Perch" item on the message list.
• messagesRead — subject, sender, date and Message-ID of the selected messages, only to create a linked task.
• alarms — one alarm per task due date.
• notifications — the system notification shown alongside each reminder (type "basic", the only type Thunderbird supports).
• tabs — find and focus the already-open board tab instead of opening duplicates, and re-point the single reminder window.
• http://127.0.0.1:8899/* and http://localhost:8899/* — this is a loopback-only host permission. "Publish calendar" POSTs the generated .ics to a small local feed server the user runs themselves (ics_server.py, distributed with the source but not inside the .xpi) so Thunderbird can subscribe to the board as a calendar. No remote host is ever contacted.

The reminder window is a packaged page, reminder.html, opened with windows.create({type:"popup"}) when a task comes due. All task data stays in storage.local. JSON export uses a Blob download from the board page; import reads only the JSON file explicitly selected by the user. The migration XPI uses the legacy ID only to upgrade the user's existing install and is not the package for this listing.
```

## 7. Before you click Submit

- **Screenshots.** The refreshed set in [`screenshots/`](../screenshots): a
  compact board with current dates, visible Daily/Weekly chips, and fewer
  competing notes; the task editor with **Repeat → Weekly**; the shortened
  in-app reminder popup; and a Windows toast example with Thunderbird branding
  and the extension's overdue-task title/message format.
  Upload the first three in order as the main listing sequence; the toast is
  an optional supplemental image if ATN accepts it. It was triggered through
  the Windows toast API for this screenshot, not by a live due alarm. The older
  `board-notes.png` and `board-today-panel.png` are superseded.
- **License.** MIT is applied in [`LICENSE`](../LICENSE). Swap the file and the
  dropdown together if you prefer MPL-2.0 or GPL-3.0.
- **ID.** `punitivepuns@proton.me` is permanent once the first version is
  uploaded, and visible to anyone who inspects the package.
- **Install check.** Install `perch-task-board-1.4.1.xpi` in Thunderbird 115+
  (Add-ons and Themes → gear → Install Add-on From File…) before uploading; that
  path is not exercised automatically here.
- **Homepage and support links.** Deliberately blank until the source is pushed.
  When the repo exists under `github.com/atrus5`, fill both fields (homepage =
  repo root, support = its `/issues`). ATN accepts an empty support field at
  submission, but a working one is expected once updates start landing.
- **Source archive.** Not needed: nothing is compiled, bundled or minified.
