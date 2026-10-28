// popup.js — browser-action popup: due-soon overview, quick add,
// "new task from this email", and the entry point to the board tab.
//
// The popup talks to extension APIs directly (it has full API access), and
// asks the background page only for its jobs: resync alarms / open the board.
"use strict";

const api =
  typeof browser !== "undefined" ? browser
  : typeof messenger !== "undefined" ? messenger
  : null;

const statusEl = document.getElementById("status");
const countsEl = document.getElementById("counts");
const listEl = document.getElementById("dueList");
const emptyEl = document.getElementById("emptyHint");
const fromEmailBtn = document.getElementById("fromEmailBtn");

function setStatus(text, cls) {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (cls ? " " + cls : "");
}

async function resyncBackground() {
  if (!api || !api.runtime || typeof api.runtime.sendMessage !== "function") return;
  try {
    await api.runtime.sendMessage({ command: "resync" });
  } catch (_) { /* background absent (dev preview) */ }
}

async function openBoard() {
  if (!api || !api.runtime || typeof api.runtime.sendMessage !== "function") return;
  try {
    const resp = await api.runtime.sendMessage({ command: "openBoard" });
    if (resp && resp.ok === false) {
      setStatus("Couldn't open the board: " + (resp.error || "unknown"), "error");
      return;
    }
    window.close();
  } catch (err) {
    setStatus("Couldn't open the board: " + ((err && err.message) || err), "error");
  }
}

/* ---------------------------------------------------------------------------
 * Due list
 * -------------------------------------------------------------------------*/
function dayDiff(isoDate, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - startOfToday.getTime()) / 86400000);
}

function groupLabel(diff) {
  if (diff < 0) return "Overdue";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  const d = new Date();
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

async function renderDueList() {
  const tasks = await tbLoadTasks();
  const now = new Date();

  const open = tasks.filter((t) => !t.done);
  const overdue = open.filter((t) => tbIsOverdue(t, now)).length;
  const dueToday = open.filter((t) => tbIsDueToday(t, now)).length;
  countsEl.textContent = open.length
    ? `${open.length} open` + (overdue ? ` · ${overdue} late` : "")
    : "";

  // Anything due within the next 7 days (plus everything already overdue).
  const upcoming = open
    .filter((t) => t.due)
    .map((t) => ({ task: t, diff: dayDiff(t.due, now) }))
    .filter((x) => x.diff !== null && x.diff <= 7)
    .sort((a, b) =>
      a.diff !== b.diff ? a.diff - b.diff
      : (tbDueMoment(a.task).getTime() - tbDueMoment(b.task).getTime())
    );

  listEl.textContent = "";
  emptyEl.classList.toggle("hidden", upcoming.length > 0);

  let lastGroup = null;
  for (const { task, diff } of upcoming) {
    const label = groupLabel(diff);
    if (label !== lastGroup) {
      lastGroup = label;
      const li = document.createElement("li");
      li.className = "due-group" +
        (label === "Overdue" ? " overdue" : label === "Today" ? " today" : "");
      li.textContent = label;
      listEl.appendChild(li);
    }
    const li = document.createElement("li");
    li.className = "due-item" + (tbIsOverdue(task, now) ? " is-overdue" : "");
    li.title = (task.notes || task.title || "") + "\n(click to open the board)";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = TB_STATUS_META[task.status]
      ? TB_STATUS_META[task.status].color
      : "#8b95a7";

    const title = document.createElement("span");
    title.className = "t";
    title.textContent = task.title || "(untitled)";

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = task.dueTime ? task.dueTime : "";

    li.appendChild(dot);
    li.appendChild(title);
    li.appendChild(when);
    li.addEventListener("click", openBoard);
    listEl.appendChild(li);
  }

  const lateCount = overdue;
  if (lateCount > 0) {
    setStatus(`${lateCount} overdue — click a task to open the board`, "error");
  } else {
    setStatus("");
  }
}

/* ---------------------------------------------------------------------------
 * Quick add
 * -------------------------------------------------------------------------*/
document.getElementById("quickAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const titleEl = document.getElementById("qTitle");
  const dueEl = document.getElementById("qDue");
  const title = titleEl.value.trim();
  if (!title) return;
  const due = dueEl.value && tbParseDateOnly(dueEl.value) ? dueEl.value : null;
  try {
    const tasks = await tbLoadTasks();
    const task = tbNormalizeTask({
      id: tbUuid(),
      title,
      notes: "",
      status: "medium",
      due,
      dueTime: due ? null : null, // date-only: morning reminder on the due day
      done: false,
      doneAt: null,
      createdAt: new Date().toISOString(),
      notifiedAt: null,
      email: null,
    });
    if (!task) throw new Error("invalid task");
    tasks.push(task);
    await tbSaveTasks(tasks);
    await resyncBackground();
    titleEl.value = "";
    dueEl.value = "";
    await renderDueList();
    // Set AFTER renderDueList — that function rewrites the status line.
    setStatus("Added ✓", "ok");
    titleEl.focus();
  } catch (err) {
    setStatus("Add failed: " + ((err && err.message) || err), "error");
  }
});

/* ---------------------------------------------------------------------------
 * Task from the currently displayed email
 * -------------------------------------------------------------------------*/
async function getDisplayedMessage() {
  if (!api || !api.messageDisplay ||
      typeof api.messageDisplay.getDisplayedMessages !== "function") {
    return null;
  }
  try {
    let tabId = null;
    if (api.tabs && typeof api.tabs.query === "function") {
      const tabs = await api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      tabId = tabs && tabs[0] ? tabs[0].id : null;
    }
    const messages = tabId != null
      ? await api.messageDisplay.getDisplayedMessages(tabId).catch(() => null)
      : await api.messageDisplay.getDisplayedMessages().catch(() => null);
    return (messages && messages[0]) || null;
  } catch (_) {
    return null;
  }
}

fromEmailBtn.addEventListener("click", async () => {
  const msg = await getDisplayedMessage();
  if (!msg) {
    setStatus("Open an email first, then click here.", "error");
    return;
  }
  try {
    const tasks = await tbLoadTasks();
    const task = tbTaskFromMessage(msg);
    if (!task) throw new Error("could not build a task");
    tasks.push(task);
    await tbSaveTasks(tasks);
    await resyncBackground();
    await renderDueList();
    setStatus("Task created from “" + (msg.subject || "no subject") + "” ✓", "ok");
  } catch (err) {
    setStatus("Failed: " + ((err && err.message) || err), "error");
  }
});

document.getElementById("openBoardBtn").addEventListener("click", openBoard);

/* ---------------------------------------------------------------------------
 * Init
 * -------------------------------------------------------------------------*/
(async function init() {
  await renderDueList();
  const msg = await getDisplayedMessage();
  if (msg) {
    fromEmailBtn.classList.remove("hidden");
    fromEmailBtn.title = "Create a task linked to:\n" + (msg.subject || "(no subject)");
  }
})().catch((err) => {
  setStatus("Init failed: " + ((err && err.message) || err), "error");
});
