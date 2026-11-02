// storage.js — shared task model for the Perch Task Board Thunderbird extension.
//
// Loaded as a classic script (no modules) by:
//   - the MV2 background page (manifest background.scripts, before background.js)
//   - board.html and popup.html, before their page scripts
// The dev preview (plain browser, no extension runtime) loads dev_shim.js
// first, which defines a localStorage-backed `browser` global.
"use strict";

/* ---------------------------------------------------------------------------
 * API handle
 * -------------------------------------------------------------------------*/
const TBApi =
  typeof browser !== "undefined" ? browser
  : typeof messenger !== "undefined" ? messenger
  : null;

/* ---------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------*/
const TB_TASKS_KEY = "tasks";
// Standalone "keep for later" notes live apart from tasks on purpose: they
// have no status/due/done, and must never leak into the .ics mirror or the
// Today panel (both iterate TB_TASKS_KEY only).
const TB_NOTES_KEY = "notes";
// Board columns, left to right. `status` doubles as the user's "status" field
// (the user picked Low/Medium/High/Urgent as their statuses).
const TB_STATUSES = ["urgent", "high", "medium", "low"];
const TB_STATUS_META = {
  urgent: { label: "Urgent", color: "#e5484d" },
  high:   { label: "High",   color: "#f5a623" },
  medium: { label: "Medium", color: "#3b82f6" },
  low:    { label: "Low",    color: "#8b95a7" },
};
// When a task has a due date but no time, we remind at this local time on
// the due day (a morning "this is due today" nudge).
const TB_DEFAULT_REMINDER_TIME = "09:00";
// Repeat cadences. A repeating task is never "finished" by ticking it off:
// ticking it advances `due` to the next occurrence (see tbNextDueDate).
const TB_REPEATS = ["none", "daily", "weekly", "monthly", "yearly"];
const TB_REPEAT_META = {
  none:    { label: "Never",   ics: null },
  daily:   { label: "Daily",   ics: "FREQ=DAILY" },
  weekly:  { label: "Weekly",  ics: "FREQ=WEEKLY" },
  monthly: { label: "Monthly", ics: "FREQ=MONTHLY" },
  yearly:  { label: "Yearly",  ics: "FREQ=YEARLY" },
};

/* ---------------------------------------------------------------------------
 * Small utilities
 * -------------------------------------------------------------------------*/
function tbUuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (_) { /* fall through */ }
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function tbIsPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Parse "YYYY-MM-DD" into a local-midnight Date, or null. */
function tbParseDateOnly(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject impossible dates like 2026-02-31 (JS rolls them over).
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 ||
      d.getDate() !== Number(m[3])) {
    return null;
  }
  return d;
}

function tbDateISO(d) {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function tbValidTime(s) {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.trim());
}

function tbMessageDateIso(value) {
  try {
    if (value == null) return null;
    let d = value;
    if (Array.isArray(d)) d = d[0];
    if (d instanceof Date) return isNaN(d) ? null : d.toISOString();
    if (typeof d === "number") return new Date(d).toISOString();
    if (typeof d === "string") {
      const parsed = new Date(d);
      return isNaN(parsed) ? null : parsed.toISOString();
    }
  } catch (_) { /* ignore */ }
  return null;
}

/* ---------------------------------------------------------------------------
 * Task model
 * -------------------------------------------------------------------------*/

/**
 * Coerce a stored/raw object into a well-formed task, or null if hopeless.
 * Field contract (everything else is tolerated and passed through):
 *   id          string, required
 *   title       string
 *   notes       string
 *   status      one of TB_STATUSES  (Urgent/High/Medium/Low)
 *   due         "YYYY-MM-DD" | null
 *   dueTime     "HH:MM"      | null   (null + due => remind at 09:00 that day)
 *   repeat      one of TB_REPEATS     (none = one-shot)
 *   done        bool, doneAt iso|null
 *   createdAt   iso string
 *   notifiedAt  iso string|null  (dedupe for the one-shot due reminder)
 *   snoozeUntil iso string|null  (reminder postponed until this moment)
 *   email       {messageId, headerMessageId, subject, author, date, folder} | null
 */
function tbNormalizeTask(raw) {
  if (!tbIsPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;

  const t = Object.assign(
    {
      title: "",
      notes: "",
      status: "medium",
      due: null,
      dueTime: null,
      repeat: "none",
      done: false,
      doneAt: null,
      createdAt: new Date().toISOString(),
      notifiedAt: null,
      snoozeUntil: null,
      email: null,
    },
    raw
  );

  t.title = typeof t.title === "string" ? t.title.trim() : "";
  t.notes = typeof t.notes === "string" ? t.notes : "";
  if (!TB_STATUSES.includes(t.status)) t.status = "medium";
  t.due = tbParseDateOnly(t.due) ? t.due : null;
  t.dueTime = tbValidTime(t.dueTime) ? t.dueTime : null;
  if (!TB_REPEATS.includes(t.repeat)) t.repeat = "none";
  // A repeat without a due date has no anchor to advance from — treat it as
  // one-shot rather than silently repeating from nowhere.
  if (!t.due) t.repeat = "none";
  t.done = !!t.done;
  t.doneAt = typeof t.doneAt === "string" ? t.doneAt : null;
  t.notifiedAt = typeof t.notifiedAt === "string" ? t.notifiedAt : null;
  // A snooze with a corrupt timestamp would silently suppress the reminder;
  // treat it as "not snoozed" so the task's normal due moment wins.
  t.snoozeUntil =
    typeof t.snoozeUntil === "string" &&
    Number.isFinite(Date.parse(t.snoozeUntil))
      ? t.snoozeUntil
      : null;
  t.createdAt = typeof t.createdAt === "string" ? t.createdAt : new Date().toISOString();
  if (t.email !== null && !tbIsPlainObject(t.email)) t.email = null;
  return t;
}

/** Read all tasks from storage. Never throws; returns [] on any failure. */
async function tbLoadTasks() {
  if (!TBApi) return [];
  try {
    const data = await TBApi.storage.local.get(TB_TASKS_KEY);
    const list = data ? data[TB_TASKS_KEY] : null;
    if (!Array.isArray(list)) return [];
    return list.map(tbNormalizeTask).filter(Boolean);
  } catch (err) {
    console.error("[Perch] tbLoadTasks failed:", err);
    return [];
  }
}

/** Atomically-ish persist the whole task array (last writer wins). */
async function tbSaveTasks(tasks) {
  if (!TBApi) throw new Error("no extension API available");
  await TBApi.storage.local.set({ [TB_TASKS_KEY]: tasks });
}

/* ---------------------------------------------------------------------------
 * Note model ("keep for later" — task-shaped, but undated and unmanaged)
 * -------------------------------------------------------------------------*/

/**
 * Coerce a stored/raw object into a well-formed note, or null if hopeless.
 * Field contract:
 *   id          string, required
 *   title       string
 *   text        string  (the body)
 *   createdAt   iso string
 *   updatedAt   iso string
 */
function tbNormalizeNote(raw) {
  if (!tbIsPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;

  const n = Object.assign(
    {
      title: "",
      text: "",
      createdAt: new Date().toISOString(),
      updatedAt: null,
    },
    raw
  );

  n.title = typeof n.title === "string" ? n.title.trim() : "";
  n.text = typeof n.text === "string" ? n.text : "";
  n.createdAt = typeof n.createdAt === "string" ? n.createdAt : new Date().toISOString();
  n.updatedAt = typeof n.updatedAt === "string" ? n.updatedAt : null;
  return n;
}

/** Read all notes from storage. Never throws; returns [] on any failure. */
async function tbLoadNotes() {
  if (!TBApi) return [];
  try {
    const data = await TBApi.storage.local.get(TB_NOTES_KEY);
    const list = data ? data[TB_NOTES_KEY] : null;
    if (!Array.isArray(list)) return [];
    return list.map(tbNormalizeNote).filter(Boolean);
  } catch (err) {
    console.error("[Perch] tbLoadNotes failed:", err);
    return [];
  }
}

/** Persist the whole note array (last writer wins). */
async function tbSaveNotes(noteList) {
  if (!TBApi) throw new Error("no extension API available");
  await TBApi.storage.local.set({ [TB_NOTES_KEY]: noteList });
}

/**
 * Build a task from a Thunderbird MessageHeader. Default: status medium,
 * due tomorrow at the default reminder time (the user reschedules from the
 * board). `overrides` may set any task field.
 */
function tbTaskFromMessage(msg, overrides) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tbNormalizeTask(
    Object.assign(
      {
        id: tbUuid(),
        title: ((msg && msg.subject) || "").trim() || "(no subject)",
        notes: "",
        status: "medium",
        due: tbDateISO(tomorrow),
        dueTime: TB_DEFAULT_REMINDER_TIME,
        done: false,
        doneAt: null,
        createdAt: new Date().toISOString(),
        notifiedAt: null,
        email: {
          messageId: msg && typeof msg.id === "number" ? msg.id : null,
          headerMessageId: (msg && msg.headerMessageId) || null,
          subject: (msg && msg.subject) || "",
          author: (msg && msg.author) || "",
          date: tbMessageDateIso(msg && msg.date),
          folder:
            msg && msg.folder
              ? {
                  accountId: msg.folder.accountId || null,
                  path: msg.folder.path || null,
                  name: msg.folder.name || null,
                }
              : null,
        },
      },
      overrides || {}
    )
  );
}

/* ---------------------------------------------------------------------------
 * Due-date / status helpers
 * -------------------------------------------------------------------------*/

/** The exact moment a task is due (date + time, default 09:00), or null. */
function tbDueMoment(task) {
  if (!task) return null;
  const day = tbParseDateOnly(task.due);
  if (!day) return null;
  const time = tbValidTime(task.dueTime) ? task.dueTime : TB_DEFAULT_REMINDER_TIME;
  const [hh, mm] = time.split(":").map(Number);
  day.setHours(hh, mm, 0, 0);
  return day;
}

/**
 * Overdue?
 *  - timed task: past its exact due moment.
 *  - date-only task: not overdue until its whole day has passed (it is
 *    "due today" until midnight).
 *  - done tasks are never overdue.
 */
function tbIsOverdue(task, now) {
  if (!task || task.done) return false;
  const due = tbDueMoment(task);
  if (!due) return false;
  const ref = now || new Date();
  if (task.dueTime) return ref.getTime() > due.getTime();
  const endOfDay = new Date(due.getTime());
  endOfDay.setHours(23, 59, 59, 999);
  return ref.getTime() > endOfDay.getTime();
}

function tbIsDueToday(task, now) {
  if (!task || task.done) return false;
  const day = tbParseDateOnly(task.due);
  if (!day) return false;
  const ref = now || new Date();
  return tbDateISO(day) === tbDateISO(ref);
}

/* ---------------------------------------------------------------------------
 * Repeating tasks
 * -------------------------------------------------------------------------*/

/** Is this task recurring? (`repeat` is "none" on ordinary one-shot tasks.) */
function tbIsRepeating(task) {
  return !!task && TB_REPEATS.includes(task.repeat) && task.repeat !== "none";
}

/** "Daily" / "Weekly" / "Monthly" / "Yearly", or "" when it doesn't repeat. */
function tbRepeatLabel(task) {
  if (!tbIsRepeating(task)) return "";
  const meta = TB_REPEAT_META[task.repeat];
  return meta ? meta.label : "";
}

/**
 * The date `k` whole repeat periods after `base` (k >= 1).
 *
 * Month/year steps clamp to the shorter month, so 31 Jan + 1 month lands on
 * 28/29 Feb instead of rolling over into March. Every candidate is computed
 * from the task's original date, which is what keeps a 31st task on the 31st
 * from drifting to the 28th after one February.
 */
function tbRepeatDateAfter(base, repeat, k) {
  const y = base.getFullYear();
  const m = base.getMonth();
  const day = base.getDate();
  if (repeat === "daily") return new Date(y, m, day + k);
  if (repeat === "weekly") return new Date(y, m, day + 7 * k);
  if (repeat === "monthly") {
    const total = m + k;
    const ty = y + Math.floor(total / 12);
    const tm = ((total % 12) + 12) % 12;
    const lastDay = new Date(ty, tm + 1, 0).getDate();
    return new Date(ty, tm, Math.min(day, lastDay));
  }
  if (repeat === "yearly") {
    const ty = y + k;
    const lastDay = new Date(ty, m + 1, 0).getDate();
    return new Date(ty, m, Math.min(day, lastDay));
  }
  return new Date(y, m, day);
}

/**
 * Next occurrence of a repeating task: the first date strictly after the
 * current day, as "YYYY-MM-DD". Returns null when the task doesn't repeat or
 * has no due date to advance from.
 *
 * `now` lets callers test against a fixed clock. A long-overdue task ("water
 * the plants", daily, last ticked three weeks ago) jumps straight to the next
 * future date rather than one step at a time from the stale one.
 */
function tbNextDueDate(dueISO, repeat, now) {
  const base = tbParseDateOnly(dueISO);
  if (!base || !TB_REPEATS.includes(repeat) || repeat === "none") return null;
  const ref = now ? new Date(now.getTime()) : new Date();
  const todayStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const periodDays =
    { daily: 1, weekly: 7, monthly: 30.44, yearly: 365.25 }[repeat] || 1;
  const span = (todayStart.getTime() - base.getTime()) / 86400000;
  let k = Math.max(1, Math.floor(span / periodDays));
  let candidate = tbRepeatDateAfter(base, repeat, k);
  let guard = 0;
  while (candidate.getTime() <= todayStart.getTime() && guard++ < 400) {
    k++;
    candidate = tbRepeatDateAfter(base, repeat, k);
  }
  return tbDateISO(candidate);
}

/** Short human label: "Overdue" / "Today" / "Tomorrow" / "Fri 24 Oct" / "". */
function tbDueLabel(task, now) {
  if (!task || !task.due) return "";
  const ref = now || new Date();
  const day = tbParseDateOnly(task.due);
  if (!day) return "";
  const startOfToday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const diffDays = Math.round((day.getTime() - startOfToday.getTime()) / 86400000);
  if (tbIsOverdue(task, ref)) return "Overdue";
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/* ---------------------------------------------------------------------------
 * Reminder helpers (used by background.js)
 * -------------------------------------------------------------------------*/

/** When the one-shot due reminder for this task should fire, or null. */
function tbReminderMoment(task) {
  if (!task || task.done) return null;
  return tbDueMoment(task);
}

/**
 * When a snoozed reminder should fire again, as ms since epoch, or null when
 * the task isn't snoozed (or the stored timestamp is unusable).
 */
function tbSnoozeMoment(task) {
  if (!task || typeof task.snoozeUntil !== "string") return null;
  const ms = Date.parse(task.snoozeUntil);
  return Number.isFinite(ms) ? ms : null;
}

/* ---------------------------------------------------------------------------
 * Email deep link
 * -------------------------------------------------------------------------*/

function tbHeaderMatches(header, ref) {
  if (!header || !ref) return false;
  if (ref.headerMessageId && header.headerMessageId) {
    return ref.headerMessageId === header.headerMessageId;
  }
  if (ref.subject && header.subject !== ref.subject) return false;
  if (ref.author && header.author !== ref.author) return false;
  return true;
}

/**
 * Open the email a task was created from, in a message tab.
 *
 * The stored messageId is an internal id: it does not survive a Thunderbird
 * restart nor follow a moved message, so we verify the id still resolves to
 * the *same* message (Message-ID header, else subject+author) before opening
 * it — otherwise we could open the wrong email. Fallbacks: headerMessageId
 * query (stable RFC Message-ID), then subject+author query.
 *
 * Throws with a human-readable message when the email can't be found.
 */
async function tbOpenEmail(task) {
  const ref = task && task.email;
  if (!ref) throw new Error("This task is not linked to an email.");
  if (!TBApi || !TBApi.messages || !TBApi.messageDisplay ||
      typeof TBApi.messageDisplay.open !== "function") {
    throw new Error("This Thunderbird build does not support opening messages from extensions (messageDisplay.open, TB 102+).");
  }

  // 1) Fast path: verify the stored id, then open it.
  if (typeof ref.messageId === "number") {
    try {
      const header = await TBApi.messages.get(ref.messageId);
      if (header && tbHeaderMatches(header, ref)) {
        await TBApi.messageDisplay.open({ messageId: header.id, location: "tab", active: true });
        return;
      }
    } catch (_) { /* id is stale; fall through */ }
  }

  // 2) Stable path: RFC Message-ID header.
  if (ref.headerMessageId) {
    try {
      const list = await TBApi.messages.query({ headerMessageId: ref.headerMessageId });
      const found = list && list.messages && list.messages[0];
      if (found) {
        await TBApi.messageDisplay.open({ messageId: found.id, location: "tab", active: true });
        return;
      }
    } catch (_) { /* fall through */ }
  }

  // 3) Last resort: subject + sender.
  if (ref.subject) {
    try {
      const criteria = { subject: ref.subject };
      if (ref.author) criteria.author = ref.author;
      const list = await TBApi.messages.query(criteria);
      const candidates = (list && list.messages) || [];
      const found = candidates.find((h) => tbHeaderMatches(h, ref)) || null;
      if (found) {
        await TBApi.messageDisplay.open({ messageId: found.id, location: "tab", active: true });
        return;
      }
    } catch (_) { /* fall through */ }
  }

  throw new Error(
    "Couldn't find that email — it may have been deleted, or moved between Thunderbird restarts."
  );
}

/* ---------------------------------------------------------------------------
 * iCalendar (.ics) export
 *
 * Thunderbird exposes no supported WebExtension calendar API (no
 * browser.calendars), so mirroring due dates into the calendar is done by
 * exporting a standards-compliant .ics the user can drag into Thunderbird's
 * Calendar (or double-click to import). Works in any Thunderbird version.
 * -------------------------------------------------------------------------*/

function tbIcsEscape(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Fold a content line at 75 octets (RFC 5545 §3.1), continuation = CRLF+SP. */
function tbIcsFold(line) {
  const bytes = line;
  if (bytes.length <= 75) return line;
  const chunks = [];
  let rest = line;
  chunks.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length > 0) {
    chunks.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  return chunks.join("\r\n");
}

function tbIcsUtcStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear() + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    "T" + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + "Z"
  );
}

function tbIcsLocalStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
    "T" + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds())
  );
}

const TB_ICS_PRIORITY = { urgent: 1, high: 3, medium: 5, low: 7 };

/**
 * Build a VEVENT for a task. Returns null when the task has no due date.
 * Date-only tasks export as all-day (VALUE=DATE); timed tasks as local
 * floating time so Thunderbird keeps the wall-clock time.
 */
function tbIcsForTask(task) {
  const start = tbDueMoment(task);
  if (!start) return null;
  const now = new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Perch Task Board//Thunderbird extension//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + tbIcsEscape(task.id + "@task-board.thunderbird"),
    "DTSTAMP:" + tbIcsUtcStamp(now),
  ];
  if (task.dueTime) {
    lines.push("DTSTART:" + tbIcsLocalStamp(start));
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    lines.push("DTEND:" + tbIcsLocalStamp(end));
  } else {
    const p = (n) => String(n).padStart(2, "0");
    const ymd =
      start.getFullYear() + p(start.getMonth() + 1) + p(start.getDate());
    lines.push("DTSTART;VALUE=DATE:" + ymd);
    const next = new Date(start.getTime());
    next.setDate(next.getDate() + 1);
    const ymd2 =
      next.getFullYear() + p(next.getMonth() + 1) + p(next.getDate());
    lines.push("DTEND;VALUE=DATE:" + ymd2);
  }
  lines.push("SUMMARY:" + tbIcsEscape(task.title || "(untitled)"));
  if (task.notes) lines.push("DESCRIPTION:" + tbIcsEscape(task.notes));
  lines.push("PRIORITY:" + (TB_ICS_PRIORITY[task.status] || 5));
  const rrule = tbIsRepeating(task) && TB_REPEAT_META[task.repeat]
    ? TB_REPEAT_META[task.repeat].ics
    : null;
  if (rrule) lines.push("RRULE:" + rrule);
  if (task.done) lines.push("STATUS:COMPLETED");
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.map(tbIcsFold).join("\r\n") + "\r\n";
}

/* ---------------------------------------------------------------------------
 * Subscribable calendar feed (task-board.ics)
 *
 * A single VCALENDAR containing one VTODO per dated, open task. This is the
 * file the board's "Publish calendar" button produces (and ics_server.py
 * serves to Thunderbird's "On My Network" calendar subscription), so board
 * tasks show up in Thunderbird's Tasks list / Today Pane next to real
 * events. One-way mirror by design: done tasks are excluded, so ticking one
 * off on the board makes it disappear from Thunderbird on the next refresh.
 * -------------------------------------------------------------------------*/

const TB_ICS_CALNAME = "Perch Task Board";

/** RFC 5545 date-only stamp: YYYYMMDD. */
function tbIcsDateOnly(date) {
  const p = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate());
}

/**
 * Lines of one VTODO component for a task, or null when it has no due date.
 * DUE is floating local time (timed tasks) or VALUE=DATE (date-only), so
 * Thunderbird keeps the wall-clock time the user typed on the board.
 */
function tbIcsVtodo(task, now) {
  const start = tbDueMoment(task);
  if (!start) return null;
  const lines = [
    "BEGIN:VTODO",
    "UID:" + tbIcsEscape(task.id + "@task-board.thunderbird"),
    "DTSTAMP:" + tbIcsUtcStamp(now),
  ];
  if (task.dueTime) {
    lines.push("DUE:" + tbIcsLocalStamp(start));
  } else {
    lines.push("DUE;VALUE=DATE:" + tbIcsDateOnly(start));
  }
  lines.push("SUMMARY:" + tbIcsEscape(task.title || "(untitled)"));
  if (task.notes) lines.push("DESCRIPTION:" + tbIcsEscape(task.notes));
  lines.push("STATUS:NEEDS-ACTION");
  lines.push("PRIORITY:" + (TB_ICS_PRIORITY[task.status] || 5));
  const meta = TB_STATUS_META[task.status];
  if (meta) lines.push("CATEGORIES:" + tbIcsEscape(meta.label));
  const rrule = tbIsRepeating(task) && TB_REPEAT_META[task.repeat]
    ? TB_REPEAT_META[task.repeat].ics
    : null;
  if (rrule) lines.push("RRULE:" + rrule);
  if (task.email && task.email.subject) {
    lines.push("X-TASK-BOARD-EMAIL:" + tbIcsEscape(task.email.subject));
  }
  lines.push("END:VTODO");
  return lines;
}

/**
 * The full task-board.ics calendar: every dated, not-done task as a VTODO,
 * oldest due first. Done tasks are intentionally excluded (the mirror
 * contract above). Returns the complete .ics text.
 */
function tbIcsCalendar(taskList) {
  const now = new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Perch Task Board//Thunderbird extension//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" + tbIcsEscape(TB_ICS_CALNAME),
  ];
  const dated = (taskList || [])
    .filter((t) => t && !t.done && t.due)
    .sort((a, b) => {
      const da = tbDueMoment(a);
      const db = tbDueMoment(b);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.getTime() - db.getTime();
    });
  for (const task of dated) {
    const vtodo = tbIcsVtodo(task, now);
    if (vtodo) lines.push(...vtodo);
  }
  lines.push("END:VCALENDAR");
  return lines.map(tbIcsFold).join("\r\n") + "\r\n";
}

/** Trigger a browser download of text content (works in extension pages). */
function tbDownloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
