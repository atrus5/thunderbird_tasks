// background.js — Perch Task Board background duties (MV2 persistent page).
//
//   1. Context menu on the message list: "Add to Perch" turns the
//      selected email(s) into tasks linked back to those messages.
//   2. Due reminders: browser.alarms (one per due task) -> two channels:
//        a) an OS notification (browser.notifications, "basic" type — a
//           Windows toast / action-center entry), and
//        b) a small reminder popup window inside Thunderbird (reminder.html),
//           so the reminder is visible even with system notifications muted.
//      Alarms do NOT survive a restart (MDN), so we rebuild them at startup
//      and whenever the task list changes (storage.onChanged, debounced).
//      Missed reminders (Thunderbird was closed when the task came due)
//      fire once as an "Overdue" catch-up on the next resync.
//   3. Toolbar badge: number of overdue tasks.
//   4. Open/focus the board tab (reused if already open).
//
// storage.js is loaded before this file (manifest background.scripts).

console.error("[Perch] background.js loaded");

const MENU_ADD_ID = "task-board-add-from-email";
const BOARD_URL = TBApi && TBApi.runtime ? TBApi.runtime.getURL("board.html") : "board.html";
const REMINDER_PREFIX = "task-due:";
const REMINDER_PAGE = "reminder.html";
let reminderWinId = null; // the one reminder popup window we keep open, if any
const OVERDUE_CATCHUP_WINDOW_MS = 1000 * 60 * 60 * 24 * 7; // ignore reminders >7 days stale
const BADGE_OVERDUE_COLOR = "#e5484d";

/* ---------------------------------------------------------------------------
 * Context menu: create task(s) from selected email(s)
 * -------------------------------------------------------------------------*/

function setupMenus() {
  if (!TBApi || !TBApi.menus) {
    console.warn("[Perch] menus API unavailable");
    return;
  }
  try {
    TBApi.menus.create({
      id: MENU_ADD_ID,
      title: "Add to Perch",
      contexts: ["message_list"],
      // menus.create's property is `onclick` (lowercase) — NOT `onClicked`,
      // which is only the listener API. Getting this wrong silently creates
      // a menu item that does nothing (Thunderbird's own quickfilter example
      // uses `onclick` in create).
      onclick: (info) => {
        addTasksFromMenu(info).catch((err) =>
          console.error("[Perch] add-from-email failed:", err)
        );
      },
    });
  } catch (err) {
    console.error("[Perch] menus.create failed:", err);
  }

  // Show the selection count in the menu label when the menu opens.
  if (typeof TBApi.menus.onShown === "object" && TBApi.menus.onShown) {
    TBApi.menus.onShown.addListener((info) => {
      try {
        const n =
          info && info.menuIds && info.menuIds.includes(MENU_ADD_ID) &&
          info.selectedMessages && Array.isArray(info.selectedMessages.messages)
            ? info.selectedMessages.messages.length
            : 0;
        TBApi.menus.update(MENU_ADD_ID, {
          title: n > 1 ? `Add ${n} emails to Perch` : "Add to Perch",
          enabled: n > 0,
        });
        TBApi.menus.refresh();
      } catch (_) { /* menu may be gone; ignore */ }
    });
  }
}

async function addTasksFromMenu(info) {
  const list = info && info.selectedMessages;
  const messages = (list && list.messages) || [];
  if (!messages.length) return;

  const tasks = await tbLoadTasks();
  let added = 0;
  for (const msg of messages.slice(0, 100)) {
    const task = tbTaskFromMessage(msg);
    if (task) {
      tasks.push(task);
      added++;
    }
  }
  if (!added) return;
  await tbSaveTasks(tasks);
  await resyncReminders();
  await openBoard();
}

/* ---------------------------------------------------------------------------
 * Reminders (alarms -> notifications)
 * -------------------------------------------------------------------------*/

async function clearAllAlarms() {
  if (!TBApi || !TBApi.alarms) return;
  try {
    if (typeof TBApi.alarms.clearAll === "function") {
      await TBApi.alarms.clearAll();
      return;
    }
    const existing = await TBApi.alarms.getAll();
    await Promise.all(
      (existing || []).map((a) => TBApi.alarms.clear(a.name).catch(() => {}))
    );
  } catch (err) {
    console.warn("[Perch] clearAllAlarms failed:", err);
  }
}

/** URL of the in-app reminder popup for a task. */
function reminderUrl(task, overdue) {
  return (
    TBApi.runtime.getURL(REMINDER_PAGE) +
    "?id=" + encodeURIComponent(task.id) +
    (overdue ? "&state=overdue" : "")
  );
}

/**
 * Show the reminder as a small popup window inside Thunderbird.
 *
 * Only one reminder window is kept: a second reminder re-points the open one
 * rather than stacking windows on the desktop. That matters at startup, where
 * several missed reminders can fire in the same resync pass.
 */
async function openReminderPopup(task, overdue) {
  if (!TBApi || !TBApi.windows || typeof TBApi.windows.create !== "function") return;
  const url = reminderUrl(task, overdue);
  try {
    if (reminderWinId != null) {
      let existing = null;
      if (typeof TBApi.windows.get === "function") {
        existing = await TBApi.windows.get(reminderWinId).catch(() => null);
      }
      const tab = existing && existing.tabs && existing.tabs[0] ? existing.tabs[0] : null;
      if (tab && TBApi.tabs && typeof TBApi.tabs.update === "function") {
        await TBApi.tabs.update(tab.id, { url, active: true });
        await TBApi.windows.update(reminderWinId, { focused: true });
        return;
      }
      reminderWinId = null; // that window is gone — fall through and reopen
    }
    let created = null;
    try {
      created = await TBApi.windows.create({
        url,
        type: "popup",
        width: 440,
        height: 260,
      });
    } catch (_) {
      // Some Thunderbird builds reject the "popup" type; a small ordinary
      // window is an acceptable fallback for the same content.
      try {
        created = await TBApi.windows.create({ url, width: 440, height: 260 });
      } catch (err) {
        console.warn("[Perch] reminder window failed:", err);
        return;
      }
    }
    if (created && created.id != null) reminderWinId = created.id;
  } catch (err) {
    console.warn("[Perch] reminder popup failed:", err);
  }
}

/**
 * Announce a due task on both channels: the OS notification and the in-app
 * Thunderbird popup. Neither is allowed to break the resync that called it.
 */
async function notifyDue(task, overdue) {
  if (!TBApi) return;
  const title = overdue
    ? "Overdue task: " + (task.title || "(untitled)")
    : "Task due: " + (task.title || "(untitled)");
  let message = "";
  if (task.due) {
    message = tbDueLabel(task) + (task.dueTime ? " at " + task.dueTime : "");
  }
  if (tbIsRepeating(task)) {
    message += (message ? "  \u00b7  " : "") + "Repeats " + tbRepeatLabel(task).toLowerCase();
  }
  if (task.email && task.email.subject) {
    message += (message ? "\n" : "") + "Re: " + task.email.subject;
  }

  // 1) OS notification — the Windows toast / action-center entry.
  if (TBApi.notifications && typeof TBApi.notifications.create === "function") {
    try {
      await TBApi.notifications.create(REMINDER_PREFIX + task.id, {
        type: "basic",
        title: title,
        message: message || " ",
        iconUrl: TBApi.runtime.getURL("icons/icon.svg"),
      });
    } catch (err) {
      // Notifications are best-effort; never let them break the resync.
      console.warn("[Perch] notification failed:", err);
    }
  }

  // 2) In-app popup window inside Thunderbird.
  await openReminderPopup(task, overdue);
}

/** Arm (or re-arm) the one alarm that announces this task's reminder. */
async function scheduleReminder(task, whenMs) {
  if (!TBApi || !TBApi.alarms) return;
  try {
    await TBApi.alarms.create(REMINDER_PREFIX + task.id, { when: whenMs });
  } catch (err) {
    console.warn("[Perch] alarms.create failed for", task.id, err);
  }
}

/**
 * Has this task's current reminder already been announced, so a resync pass
 * (or a leftover alarm) must stay quiet?
 *
 * `notifiedAt` dedupes the single announcement a due value gets — but a
 * snooze deliberately asks for another one at a later moment, so a task is
 * announced again once its snooze time passes even though `notifiedAt` still
 * holds the earlier notice. A snooze still in the future means "quiet for
 * now", and one already superseded by a later notification stays quiet too.
 */
function reminderWasAnnounced(task, now) {
  const snoozeMs = tbSnoozeMoment(task);
  if (snoozeMs === null) return !!task.notifiedAt;
  if (snoozeMs > now) return true;
  const notifiedMs = task.notifiedAt ? Date.parse(task.notifiedAt) : NaN;
  return Number.isFinite(notifiedMs) && notifiedMs >= snoozeMs;
}

/**
 * Should this reminder be titled "Overdue" rather than "Due"?
 * An alarm firing within 5 minutes of the due moment is punctual (not
 * overdue) — without this, every on-time notification would read
 * "Overdue" because `now` is already past `due`. For date-only tasks the
 * day must also actually be over (tbIsOverdue).
 */
function reminderIsOverdue(task, dueMs, now) {
  if (now - dueMs <= 5 * 60 * 1000) return false;
  return tbIsOverdue(task, new Date(now));
}

/**
 * Rebuild alarms from the current task list, fire missed reminders, and
 * refresh the overdue badge. Called at startup, after every task write and
 * on the debounced storage change event.
 *
 * Passes are serialized: startup, a page's "resync" message and the storage
 * watcher can all land together, and two overlapping passes would both see a
 * task with no `notifiedAt` and announce it twice (two OS notifications, two
 * reminder windows). Queuing them means the second pass sees the first one's
 * write and stays quiet.
 */
let resyncChain = Promise.resolve();
function resyncReminders() {
  resyncChain = resyncChain
    .catch(() => { /* a failed pass must not poison the queue */ })
    .then(runResyncPass);
  return resyncChain;
}

async function runResyncPass() {
  const tasks = await tbLoadTasks();
  const now = Date.now();
  let changed = false;

  await clearAllAlarms();

  for (const task of tasks) {
    const due = tbReminderMoment(task); // null when done or unscheduled
    if (!due) continue;
    const dueMs = due.getTime();
    const snoozeMs = tbSnoozeMoment(task);

    // Snoozed into the future: re-arm at the snooze moment and stay quiet.
    // (The task is still due-overdue; the user just postponed the nag.)
    if (snoozeMs !== null && snoozeMs > now) {
      await scheduleReminder(task, snoozeMs);
      continue;
    }

    if (dueMs <= now) {
      // Reminder time has passed and Thunderbird never fired it (was closed,
      // or the task was just created already-due). Fire once per due value;
      // `notifiedAt` dedupes, editing the due date resets it, and a passed
      // snooze re-announces exactly once more.
      if (reminderWasAnnounced(task, now)) continue;
      const snoozed = snoozeMs !== null;
      const stale = now - dueMs > OVERDUE_CATCHUP_WINDOW_MS;
      if (stale && !snoozed) {
        // Way-too-old reminder (e.g. ancient imported task): mark handled,
        // don't nag with a weeks-late pop-up.
        task.notifiedAt = new Date().toISOString();
        task.snoozeUntil = null;
        changed = true;
        continue;
      }
      await notifyDue(task, reminderIsOverdue(task, dueMs, now));
      task.notifiedAt = new Date().toISOString();
      task.snoozeUntil = null;
      changed = true;
    } else {
      await scheduleReminder(task, dueMs);
    }
  }

  if (changed) {
    try {
      await tbSaveTasks(tasks);
    } catch (err) {
      console.error("[Perch] saving notifiedAt failed:", err);
    }
  }

  await updateBadge(tasks);
}

TBApi &&
  TBApi.alarms &&
  TBApi.alarms.onAlarm &&
  TBApi.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || typeof alarm.name !== "string" ||
        !alarm.name.startsWith(REMINDER_PREFIX)) {
      return;
    }
    const id = alarm.name.slice(REMINDER_PREFIX.length);
    (async () => {
      const tasks = await tbLoadTasks();
      const task = tasks.find((t) => t.id === id);
      if (!task || task.done) return;
      const now = Date.now();
      // Already announced, or snoozed for later, or a stale alarm for an
      // earlier due value: stay quiet (the resync pass re-arms the alarm).
      if (reminderWasAnnounced(task, now)) return;
      const due = tbReminderMoment(task);
      if (!due) return;
      // Write the dedupe marker before announcing: a resync pass racing this
      // alarm then sees the task as handled rather than announcing it twice.
      task.notifiedAt = new Date().toISOString();
      task.snoozeUntil = null;
      try {
        await tbSaveTasks(tasks);
      } catch (err) {
        console.warn("[Perch] saving reminder state failed:", err);
      }
      await notifyDue(task, reminderIsOverdue(task, due.getTime(), now));
      await updateBadge(tasks);
    })().catch((err) => console.error("[Perch] onAlarm failed:", err));
  });

TBApi &&
  TBApi.notifications &&
  TBApi.notifications.onClicked &&
  TBApi.notifications.onClicked.addListener((notificationId) => {
    if (typeof notificationId === "string" &&
        notificationId.startsWith(REMINDER_PREFIX)) {
      openBoard().catch(() => {});
    }
  });

// Forget our reminder window when the user closes it, so the next reminder
// opens a fresh one instead of trying to re-point a dead window id.
TBApi &&
  TBApi.windows &&
  TBApi.windows.onRemoved &&
  TBApi.windows.onRemoved.addListener((windowId) => {
    if (windowId === reminderWinId) reminderWinId = null;
  });

/** Clear the toast for a snoozed reminder and re-arm its alarm. */
async function snoozeReminder(taskId) {
  if (TBApi && TBApi.notifications &&
      typeof TBApi.notifications.clear === "function") {
    try {
      await TBApi.notifications.clear(REMINDER_PREFIX + taskId);
    } catch (_) { /* nothing showing, or unsupported; not an error */ }
  }
  await resyncReminders();
}

/* ---------------------------------------------------------------------------
 * Badge: overdue count
 * -------------------------------------------------------------------------*/

async function updateBadge(tasks) {
  if (!TBApi || !TBApi.browserAction) return;
  const list = Array.isArray(tasks) ? tasks : await tbLoadTasks();
  const now = new Date();
  const overdue = list.filter((t) => tbIsOverdue(t, now)).length;
  try {
    await TBApi.browserAction.setBadgeText({
      text: overdue > 0 ? String(Math.min(overdue, 99)) : "",
    });
    if (overdue > 0 && typeof TBApi.browserAction.setBadgeBackgroundColor === "function") {
      await TBApi.browserAction.setBadgeBackgroundColor({ color: BADGE_OVERDUE_COLOR });
    }
  } catch (_) { /* badge unsupported in this build; ignore */ }
}

/* ---------------------------------------------------------------------------
 * Board tab
 * -------------------------------------------------------------------------*/

async function openBoard() {
  if (!TBApi) return;
  try {
    const tabs = await TBApi.tabs.query({});
    const existing = (tabs || []).find((t) => t.url === BOARD_URL);
    if (existing) {
      await TBApi.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) {
        await TBApi.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
    await TBApi.tabs.create({ url: BOARD_URL });
  } catch (err) {
    console.error("[Perch] openBoard failed:", err);
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * Messaging (pages asking the background to do its jobs)
 * -------------------------------------------------------------------------*/

TBApi &&
  TBApi.runtime &&
  TBApi.runtime.onMessage &&
  TBApi.runtime.onMessage.addListener((request) => {
    if (!request || typeof request.command !== "string") return undefined;
    if (request.command === "resync") {
      // A page changed the task list: rebuild alarms + badge.
      return resyncReminders()
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, error: String(err) }));
    }
    if (request.command === "openBoard") {
      return openBoard()
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, error: String(err) }));
    }
    if (request.command === "snooze" && typeof request.id === "string") {
      // reminder.js already stored the new `snoozeUntil`; finish the job by
      // pulling the original toast out of the notification area and arming
      // the alarm for the new moment right away (instead of waiting for the
      // debounced storage watcher).
      return snoozeReminder(request.id)
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, error: String(err) }));
    }
    return undefined;
  });

/* ---------------------------------------------------------------------------
 * Storage changes: debounced resync (covers writes from any context)
 * -------------------------------------------------------------------------*/

let resyncTimer = null;
TBApi &&
  TBApi.storage &&
  TBApi.storage.onChanged &&
  TBApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, TB_TASKS_KEY)) {
      return;
    }
    if (resyncTimer) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      resyncReminders().catch((err) =>
        console.warn("[Perch] resync after change failed:", err)
      );
    }, 800);
  });

/* ---------------------------------------------------------------------------
 * Startup
 * -------------------------------------------------------------------------*/

setupMenus();
resyncReminders().catch((err) =>
  console.error("[Perch] startup resync failed:", err)
);
