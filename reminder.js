// reminder.js — the reminder popup window opened by background.js when a task
// comes due. It is BOTH halves' visible part: the OS notification carries the
// headline, this window carries the task details and the two actions.
//
// The window is opened with `reminder.html?id=<taskId>` (plus `state=overdue`
// when background.js already decided the reminder is late). It reads the task
// from the shared store, so it always shows the current title/due date rather
// than a stale snapshot passed in the URL.
"use strict";

const params = new URLSearchParams(location.search);
const taskId = params.get("id") || "";
const overdueHint = params.get("state") === "overdue";

const kindEl = document.getElementById("remKind");
const whenEl = document.getElementById("remWhen");
const titleEl = document.getElementById("remTitle");
const metaEl = document.getElementById("remMeta");
const notesEl = document.getElementById("remNotes");
const emailEl = document.getElementById("remEmail");
const errorEl = document.getElementById("remError");

/** Ask the background page to do one of its jobs (open the board, etc.). */
function send(command) {
  if (!TBApi || !TBApi.runtime || typeof TBApi.runtime.sendMessage !== "function") {
    return Promise.resolve(null);
  }
  return TBApi.runtime.sendMessage({ command }).catch(() => null);
}

function chip(text, extraClass) {
  const span = document.createElement("span");
  span.className = "chip" + (extraClass ? " " + extraClass : "");
  span.textContent = text;
  return span;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function renderTask(task, overdue) {
  kindEl.textContent = overdue ? "Overdue task" : "Task due";
  kindEl.classList.toggle("overdue", overdue);
  document.title = (overdue ? "Overdue: " : "Due: ") + (task.title || "(untitled)");
  titleEl.textContent = task.title || "(untitled)";

  const dueLabel = tbDueLabel(task);
  whenEl.textContent = dueLabel
    ? dueLabel + (task.dueTime ? " · " + task.dueTime : "")
    : "";

  metaEl.textContent = "";
  const statusMeta = TB_STATUS_META[task.status];
  if (statusMeta) metaEl.appendChild(chip(statusMeta.label));
  if (dueLabel === "Overdue") metaEl.appendChild(chip("Overdue", "overdue"));
  else if (dueLabel === "Today") metaEl.appendChild(chip("Today", "today"));
  if (tbIsRepeating(task)) {
    metaEl.appendChild(chip("\u{1F501} " + tbRepeatLabel(task), "repeat"));
  }

  if (task.notes) {
    notesEl.textContent = task.notes;
    notesEl.classList.remove("hidden");
  }

  if (task.email && task.email.subject) {
    const from = task.email.author ? task.email.author + " — " : "";
    emailEl.textContent = "\u2709 " + from + task.email.subject;
    emailEl.title = from + task.email.subject;
    emailEl.classList.remove("hidden");
  }

  if (task.done) showError("Marked done on the board since this reminder fired.");
}

(async function init() {
  const list = await tbLoadTasks();
  const task = list.find((t) => t.id === taskId) || null;

  if (!task) {
    kindEl.textContent = "Reminder";
    titleEl.textContent = "This task is no longer on the board";
    showError("It may have been completed or deleted since the reminder fired.");
    return;
  }
  renderTask(task, overdueHint || tbIsOverdue(task));
})().catch((err) => {
  console.error("[Perch] reminder failed:", err);
  titleEl.textContent = "Couldn't load this reminder";
  showError(String((err && err.message) || err));
});

/* ---------------------------------------------------------------------------
 * Actions
 * -------------------------------------------------------------------------*/

document.getElementById("dismissBtn").addEventListener("click", () => {
  window.close();
});

document.getElementById("boardBtn").addEventListener("click", async () => {
  await send("openBoard");
  window.close();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.close();
});
