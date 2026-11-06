// board.js — Perch Task Board main page.
//
// Four status columns (Urgent / High / Medium / Low). Tasks are cards:
//   - drag a card within its column  -> reorder (persisted per status)
//   - drag a card to another column  -> change its status
//   - click a card                   -> edit dialog (due date + time, notes)
//   - checkbox on a card             -> mark done (moves to the Done strip)
//
// Ordering model: a single flat `tasks` array is the source of truth.
// A column renders `tasks.filter(t => !t.done && t.status === S)` in array
// order, so "manual order" = relative array order within each status group.
// Drop positions are rewritten into that same array (applyDrop).
//
// Drag & drop uses native HTML5 DnD with event delegation on #board, so a
// re-render mid-drag never detaches the handlers.
"use strict";

/* ---------------------------------------------------------------------------
 * State
 * -------------------------------------------------------------------------*/
let tasks = [];
let notes = [];              // standalone "keep for later" notes (storage key `notes`)
let pendingReload = false;      // storage changed while the dialog was open
let suppressDragClick = false;  // a click right after a drop must not edit
let editingId = null;           // task id in the dialog, null = new task
let editingNoteId = null;       // note id in the dialog, null = new note
let dialogMode = "task";        // what the dialog is editing: "task" | "note"
let dragId = null;              // task id being dragged

const $ = (sel) => document.querySelector(sel);
const boardEl = $("#board");
const summaryEl = $("#summary");
const dialog = $("#taskDialog");
const form = $("#taskForm");
const toastEl = $("#toast");

const placeholder = document.createElement("div");
placeholder.className = "drop-placeholder";

/* ---------------------------------------------------------------------------
 * Toast
 * -------------------------------------------------------------------------*/
let toastTimer = null;
function toast(message, isError) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3500);
}

/* ---------------------------------------------------------------------------
 * Persistence
 * -------------------------------------------------------------------------*/
async function persist() {
  try {
    await tbSaveTasks(tasks);
  } catch (err) {
    toast("Save failed: " + ((err && err.message) || err), true);
    throw err;
  }
  // Rebuild alarms + overdue badge in the background page.
  if (TBApi && TBApi.runtime && typeof TBApi.runtime.sendMessage === "function") {
    try {
      await TBApi.runtime.sendMessage({ command: "resync" });
    } catch (_) {
      // Background may be unavailable in dev preview — fine.
    }
  }
}

/** Persist the note list (toasts + rethrows on failure, like persist). */
async function persistNotes() {
  try {
    await tbSaveNotes(notes);
  } catch (err) {
    toast("Save failed: " + ((err && err.message) || err), true);
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * Render
 * -------------------------------------------------------------------------*/
function statusTasks(status) {
  return tasks.filter((t) => !t.done && t.status === status);
}

function renderSummary() {
  const now = new Date();
  const open = tasks.filter((t) => !t.done).length;
  const overdue = tasks.filter((t) => tbIsOverdue(t, now)).length;
  const today = tasks.filter((t) => tbIsDueToday(t, now)).length;
  const done = tasks.filter((t) => t.done).length;
  const parts = [`${open} open`];
  if (overdue) parts.push(`${overdue} overdue`);
  if (today) parts.push(`${today} due today`);
  if (done) parts.push(`${done} done`);
  summaryEl.textContent = parts.join("  ·  ");
}

function dueChip(task) {
  const label = tbDueLabel(task);
  if (!label) return null;
  const chip = document.createElement("span");
  chip.className = "chip " + (
    label === "Overdue" ? "due-overdue"
    : label === "Today" ? "due-today"
    : "due-soon"
  );
  chip.textContent = label + (task.dueTime ? " " + task.dueTime : "");
  return chip;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildCard(task) {
  const card = document.createElement("article");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = task.id;
  card.tabIndex = 0;

  const check = document.createElement("label");
  check.className = "check";
  check.title = "Mark done";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!task.done;
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => toggleDone(task.id, cb.checked));
  check.appendChild(cb);

  const main = document.createElement("div");
  main.className = "card-main";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = task.title || "(untitled)";
  main.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const due = dueChip(task);
  if (due) meta.appendChild(due);
  if (tbIsRepeating(task)) {
    const rc = document.createElement("span");
    rc.className = "chip repeat-chip";
    rc.textContent = "\u{1F501} " + tbRepeatLabel(task);
    rc.title = "Repeats " + tbRepeatLabel(task).toLowerCase() +
      " \u2014 ticking it off moves it to its next date";
    meta.appendChild(rc);
  }
  if (task.email && task.email.subject) {
    const em = document.createElement("span");
    em.className = "chip email-chip";
    em.textContent = "✉ " + task.email.subject;
    em.title = "From: " + (task.email.author || "unknown sender") + "\nClick the card to open the email from the editor.";
    em.addEventListener("click", (e) => {
      e.stopPropagation();
      openEmail(task);
    });
    meta.appendChild(em);
  }
  if (task.notes) {
    const nc = document.createElement("span");
    nc.className = "chip notes-chip";
    nc.textContent = "📝";
    nc.title = task.notes;
    meta.appendChild(nc);
  }
  if (meta.childNodes.length) main.appendChild(meta);

  card.appendChild(check);
  card.appendChild(main);
  return card;
}

function renderBoard() {
  boardEl.textContent = "";
  for (const status of TB_STATUSES) {
    const meta = TB_STATUS_META[status];
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.status = status;

    const head = document.createElement("div");
    head.className = "column-head";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = meta.color;
    const colTitle = document.createElement("span");
    colTitle.className = "col-title";
    colTitle.textContent = meta.label;
    const colCount = document.createElement("span");
    colCount.className = "col-count";
    colCount.textContent = "0";
    const actions = document.createElement("span");
    actions.className = "col-actions";
    const sortButton = document.createElement("button");
    sortButton.type = "button";
    sortButton.className = "sort-btn";
    sortButton.title = "Sort this column by due date";
    sortButton.textContent = "⇅";
    sortButton.addEventListener("click", () => sortColumnByDue(status));
    actions.appendChild(sortButton);
    head.append(dot, colTitle, colCount, actions);

    const body = document.createElement("div");
    body.className = "column-body";
    body.dataset.status = status;

    const group = statusTasks(status);
    colCount.textContent = String(group.length);
    if (!group.length) {
      const hint = document.createElement("p");
      hint.className = "empty-hint";
      hint.textContent = "No tasks";
      body.appendChild(hint);
    }
    for (const task of group) body.appendChild(buildCard(task));

    column.appendChild(head);
    column.appendChild(body);
    boardEl.appendChild(column);
  }
  renderSummary();
  renderToday();
  renderNotes();
  renderDone();
}

/* ---------------------------------------------------------------------------
 * Today panel — everything overdue or due today, regardless of status
 * -------------------------------------------------------------------------*/
function renderToday() {
  const panel = $("#todayPanel");
  const list = $("#todayList");
  const now = new Date();

  $("#todayDate").textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const todays = tasks
    .filter((t) => !t.done && (tbIsOverdue(t, now) || tbIsDueToday(t, now)))
    .sort((a, b) => {
      const ma = tbDueMoment(a);
      const mb = tbDueMoment(b);
      if (!ma && !mb) return 0;
      if (!ma) return 1;
      if (!mb) return -1;
      return ma.getTime() - mb.getTime();
    });

  $("#todayCount").textContent = String(todays.length);
  panel.classList.toggle("empty", todays.length === 0);

  list.textContent = "";
  if (!todays.length) {
    const hint = document.createElement("p");
    hint.className = "today-empty";
    hint.textContent = "Nothing due today \u{1F389}";
    list.appendChild(hint);
    return;
  }

  for (const task of todays) {
    const row = document.createElement("div");
    row.className = "today-item";
    row.dataset.id = task.id;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.title = "Mark done";
    cb.addEventListener("change", () => toggleDone(task.id, cb.checked));
    row.appendChild(cb);

    const meta = TB_STATUS_META[task.status] || TB_STATUS_META.medium;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = meta.color;
    dot.title = meta.label + " priority";
    row.appendChild(dot);

    const title = document.createElement("span");
    title.className = "today-title-text";
    title.textContent = task.title || "(untitled)";
    title.title = "Open in the editor";
    title.addEventListener("click", () => openEditor(task.id));
    row.appendChild(title);

    // Overdue / time chip (dueChip returns "" when the label is empty, which
    // can't happen here — the filter requires a due date — but stay safe).
    const due = dueChip(task);
    if (due) row.appendChild(due);

    if (task.email && task.email.subject) {
      const em = document.createElement("span");
      em.className = "chip email-chip";
      em.textContent = "\u2709 " + task.email.subject;
      em.title = "From: " + (task.email.author || "unknown sender") + "\nClick the title to open the email from the editor.";
      em.addEventListener("click", () => openEmail(task));
      row.appendChild(em);
    }

    list.appendChild(row);
  }
}

function renderDone() {
  const doneTasks = tasks.filter((t) => t.done);
  $("#doneCount").textContent = String(doneTasks.length);
  const list = $("#doneList");
  const clearBtn = $("#clearDoneBtn");

  // Always rebuild the rows — visibility is controlled separately below.
  // (Rows used to be built only when the strip was already open, so a task
  // checked off while the strip was closed showed an EMPTY done list.)
  list.textContent = "";
  for (const task of doneTasks) {
    const row = document.createElement("div");
    row.className = "done-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.title = "Restore to board";
    cb.addEventListener("change", () => toggleDone(task.id, false));
    const title = document.createElement("span");
    title.className = "done-title";
    title.textContent = task.title || "(untitled)";
    title.title = task.title || "";
    row.appendChild(cb);
    row.appendChild(title);
    list.appendChild(row);
  }

  clearBtn.classList.toggle("hidden", doneTasks.length === 0);
  const open = list.dataset.open === "1" && doneTasks.length > 0;
  list.classList.toggle("hidden", !open);
  $("#doneToggle").setAttribute("aria-expanded", String(open));
}

function rerender() {
  if (dialog.open) {
    pendingReload = true;
    return;
  }
  renderBoard();
}

/* ---------------------------------------------------------------------------
 * Notes panel — task-shaped entries kept for later (no status/due/done,
 * never published to the calendar). Order is manual: new notes land on top
 * and can be dragged around afterwards.
 * -------------------------------------------------------------------------*/
const notesListEl = $("#notesList");
const noteQuickEl = $("#noteQuick");
let dragNoteId = null;
let suppressNoteClick = false;
const notePlaceholder = document.createElement("div");
notePlaceholder.className = "drop-placeholder";

function noteDateLabel(note) {
  const d = new Date(note.updatedAt || note.createdAt);
  if (isNaN(d)) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function renderNotes() {
  $("#notesCount").textContent = String(notes.length);
  notesListEl.textContent = "";

  if (!notes.length) {
    const hint = document.createElement("p");
    hint.className = "notes-empty";
    hint.textContent = "No notes yet — jot one above, or use New note";
    notesListEl.appendChild(hint);
    return;
  }

  for (const note of notes) {
    const card = document.createElement("article");
    card.className = "note-card";
    card.draggable = true;
    card.dataset.id = note.id;
    card.tabIndex = 0;
    card.title = note.title || "";

    const title = document.createElement("div");
    title.className = "note-title";
    title.textContent = note.title || "(untitled)";
    card.appendChild(title);

    if (note.text) {
      const body = document.createElement("div");
      body.className = "note-text";
      body.textContent = note.text;
      card.appendChild(body);
    }

    const meta = document.createElement("div");
    meta.className = "note-meta";

    const date = document.createElement("span");
    date.className = "note-date";
    const label = noteDateLabel(note);
    if (label) date.textContent = (note.updatedAt ? "edited " : "") + label;
    meta.appendChild(date);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "note-del";
    del.textContent = "Delete";
    del.title = "Delete this note";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteNoteFromList(del, note.id);
    });
    meta.appendChild(del);

    card.appendChild(meta);
    notesListEl.appendChild(card);
  }
}

/** Two-click confirm delete from a card in the list (not the dialog). */
async function deleteNoteFromList(btn, id) {
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.classList.add("armed");
    btn.textContent = "Really?";
    setTimeout(() => {
      if (btn.dataset.armed === "1" && btn.isConnected) {
        btn.dataset.armed = "0";
        btn.classList.remove("armed");
        btn.textContent = "Delete";
      }
    }, 3000);
    return;
  }
  const idx = notes.findIndex((n) => n.id === id);
  if (idx < 0) return;
  const removed = notes[idx];
  notes = notes.filter((n) => n.id !== id);
  try {
    await persistNotes();
  } catch (_) {
    notes.splice(Math.min(idx, notes.length), 0, removed); // put it back
    renderNotes();
    return;
  }
  renderNotes();
  toast("Note deleted");
}

/* Quick capture: type a title, press Enter — no dialog needed. */
async function quickAddNote() {
  const title = noteQuickEl.value.trim();
  if (!title) return;
  const note = tbNormalizeNote({
    id: tbUuid(),
    title,
    text: "",
    createdAt: new Date().toISOString(),
    updatedAt: null,
  });
  if (!note) return;
  notes.unshift(note);
  noteQuickEl.value = "";
  try {
    await persistNotes();
  } catch (_) {
    notes = notes.filter((n) => n.id !== note.id);
    return;
  }
  renderNotes();
  toast("Note kept — click it to add the text");
  noteQuickEl.focus();
}

noteQuickEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  quickAddNote().catch(() => { /* toast already shown */ });
});

notesListEl.addEventListener("click", (e) => {
  if (suppressNoteClick) return;
  if (e.target.closest && e.target.closest(".note-del")) return;
  const card = e.target.closest && e.target.closest(".note-card");
  if (!card || !card.dataset.id) return;
  openNoteEditor(card.dataset.id);
});

notesListEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest && e.target.closest(".note-card");
  if (!card || e.target !== card) return; // don't hijack buttons inside
  e.preventDefault();
  openNoteEditor(card.dataset.id);
});

/* Notes drag & drop — reorder only (a note has no column to move to). */
notesListEl.addEventListener("dragstart", (e) => {
  const card = e.target.closest && e.target.closest(".note-card");
  if (!card || !card.dataset.id) return;
  dragNoteId = card.dataset.id;
  suppressNoteClick = true;
  try {
    e.dataTransfer.setData("text/plain", dragNoteId);
    e.dataTransfer.effectAllowed = "move";
  } catch (_) { /* some hosts restrict dataTransfer */ }
  requestAnimationFrame(() => {
    if (dragNoteId === card.dataset.id) card.classList.add("dragging");
    if (card.parentNode) card.parentNode.insertBefore(notePlaceholder, card.nextSibling);
  });
});

notesListEl.addEventListener("dragover", (e) => {
  if (!dragNoteId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

  const cards = Array.from(notesListEl.querySelectorAll(".note-card:not(.dragging)"));
  if (!cards.length) {
    if (notePlaceholder.parentNode !== notesListEl) notesListEl.appendChild(notePlaceholder);
    return;
  }
  // Reading-order rule (works for the wrapping grid): the first card whose
  // centre is below the pointer, or in the same row but to its right.
  let target = null;
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    const cx = r.left + r.width / 2;
    const sameRow = Math.abs(e.clientY - cy) < r.height / 2;
    if (e.clientY < cy || (sameRow && e.clientX < cx)) {
      target = card;
      break;
    }
  }
  if (target) {
    if (notePlaceholder.nextSibling !== target) notesListEl.insertBefore(notePlaceholder, target);
  } else if (notesListEl.lastElementChild !== notePlaceholder) {
    notesListEl.appendChild(notePlaceholder);
  }
});

notesListEl.addEventListener("drop", (e) => {
  if (!dragNoteId) return;
  e.preventDefault();

  // Position = number of rendered cards before the placeholder (the dragged
  // card itself is hidden and sits before it in the DOM, so it's skipped).
  let index = 0;
  for (const child of notesListEl.children) {
    if (child === notePlaceholder) break;
    if (child.classList && child.classList.contains("note-card") &&
        !child.classList.contains("dragging")) {
      index++;
    }
  }
  const id = dragNoteId;
  cleanupNoteDrag();
  reorderNotes(id, index).catch(() => { /* toast already shown */ });
});

notesListEl.addEventListener("dragend", () => {
  cleanupNoteDrag();
  setTimeout(() => { suppressNoteClick = false; }, 250);
});

function cleanupNoteDrag() {
  if (notePlaceholder.parentNode) notePlaceholder.parentNode.removeChild(notePlaceholder);
  const dragged = dragNoteId
    ? notesListEl.querySelector(`.note-card[data-id="${CSS.escape(dragNoteId)}"]`)
    : null;
  if (dragged) dragged.classList.remove("dragging");
  dragNoteId = null;
}

async function reorderNotes(id, index) {
  const moved = notes.find((n) => n.id === id);
  if (!moved) return;
  const others = notes.filter((n) => n.id !== id);
  const insertAt = Math.max(0, Math.min(index, others.length));
  others.splice(insertAt, 0, moved);
  notes = others;
  renderNotes();
  try {
    await persistNotes();
  } catch (_) { /* toast already shown */ }
}

/* ---------------------------------------------------------------------------
 * Done / restore / clear
 * -------------------------------------------------------------------------*/
async function toggleDone(id, done) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  // A repeating task is never "finished": ticking it off schedules the next
  // occurrence, keeps it on the board and re-arms its reminder.
  if (done && tbIsRepeating(task)) {
    await rollRepeatForward(task);
    return;
  }
  task.done = done;
  task.doneAt = done ? new Date().toISOString() : null;
  task.snoozeUntil = null;   // a snooze belongs to the reminder, not the task
  try {
    await persist();
  } catch (_) { /* toast already shown */ }
  renderBoard();
}

/**
 * Move a repeating task to its next occurrence. The old due date is restored
 * if the save fails, so a failed write can never quietly invent a new date.
 */
async function rollRepeatForward(task) {
  const next = tbNextDueDate(task.due, task.repeat);
  if (!next) {
    toast("This task repeats but has no due date to repeat from — set one in the editor", true);
    return;
  }
  const previousDue = task.due;
  const previousNotified = task.notifiedAt;
  const previousSnooze = task.snoozeUntil;
  task.due = next;
  task.notifiedAt = null;   // a fresh occurrence gets a fresh reminder
  task.snoozeUntil = null;
  task.done = false;
  task.doneAt = null;
  try {
    await persist();
  } catch (_) {
    task.due = previousDue;
    task.notifiedAt = previousNotified;
    task.snoozeUntil = previousSnooze;
    renderBoard();
    return;
  }
  renderBoard();
  const when = tbDueLabel(task) + (task.dueTime ? " at " + task.dueTime : "");
  toast(`Done — repeats ${tbRepeatLabel(task).toLowerCase()}, next ${when}`);
}

async function clearDone() {
  const before = tasks.length;
  tasks = tasks.filter((t) => !t.done);
  if (tasks.length === before) return;
  try {
    await persist();
  } catch (_) { return; }
  renderBoard();
  toast("Cleared completed tasks");
}

/* ---------------------------------------------------------------------------
 * Sort a column by due date (rewrites manual order for that status)
 * -------------------------------------------------------------------------*/
async function sortColumnByDue(status) {
  const group = statusTasks(status);
  if (group.length < 2) return;
  const sorted = group.slice().sort((a, b) => {
    const da = tbDueMoment(a);
    const db = tbDueMoment(b);
    if (!da && !db) return 0;
    if (!da) return 1;   // unscheduled last
    if (!db) return -1;
    return da.getTime() - db.getTime();
  });
  let i = 0;
  tasks = tasks.map((t) =>
    !t.done && t.status === status ? sorted[i++] : t
  );
  try {
    await persist();
  } catch (_) { return; }
  renderBoard();
  toast(`Sorted ${TB_STATUS_META[status].label} by due date`);
}

/* ---------------------------------------------------------------------------
 * Drag & drop
 * -------------------------------------------------------------------------*/
function clearDropStyles() {
  for (const el of boardEl.querySelectorAll(".drop-active")) {
    el.classList.remove("drop-active");
  }
}

function cleanupDrag() {
  if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
  const dragged = dragId
    ? boardEl.querySelector(`.card[data-id="${CSS.escape(dragId)}"]`)
    : null;
  if (dragged) dragged.classList.remove("dragging");
  clearDropStyles();
  dragId = null;
}

boardEl.addEventListener("dragstart", (e) => {
  const card = e.target.closest && e.target.closest(".card");
  if (!card || !card.dataset.id) return;
  dragId = card.dataset.id;
  suppressDragClick = true;
  try {
    e.dataTransfer.setData("text/plain", dragId);
    e.dataTransfer.effectAllowed = "move";
  } catch (_) { /* some hosts restrict dataTransfer */ }
  // Hide the source card only after the drag image has been captured.
  requestAnimationFrame(() => {
    if (dragId === card.dataset.id) card.classList.add("dragging");
    // Insert placeholder where the card was, so the column doesn't collapse.
    if (card.parentNode) card.parentNode.insertBefore(placeholder, card.nextSibling);
  });
});

boardEl.addEventListener("dragover", (e) => {
  if (!dragId) return;
  const body = e.target.closest && e.target.closest(".column-body");
  if (!body) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  clearDropStyles();
  body.classList.add("drop-active");

  // Find the card below the pointer and put the placeholder above it.
  const cards = Array.from(body.querySelectorAll(".card:not(.dragging)"));
  let before = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      before = card;
      break;
    }
  }
  if (before) {
    if (placeholder.nextSibling !== before) body.insertBefore(placeholder, before);
  } else if (body.lastElementChild !== placeholder) {
    body.appendChild(placeholder);
  }
});

boardEl.addEventListener("drop", (e) => {
  if (!dragId) return;
  const body = e.target.closest && e.target.closest(".column-body");
  e.preventDefault();
  if (!body) return;
  const status = body.dataset.status;
  const id = dragId;

  // Count rendered cards before the placeholder inside the target column.
  let index = 0;
  for (const child of body.children) {
    if (child === placeholder) break;
    if (child.classList && child.classList.contains("card") &&
        !child.classList.contains("dragging")) {
      index++;
    }
  }

  cleanupDrag();
  applyDrop(id, status, index);
  persist().then(() => renderBoard()).catch(() => {});
});

boardEl.addEventListener("dragend", () => {
  cleanupDrag();
  // A click event usually follows a drag; ignore the next one.
  setTimeout(() => { suppressDragClick = false; }, 250);
});

/**
 * Move `id` into `status` at visible position `index`, rewriting the flat
 * task array so the new per-status order sticks.
 */
function applyDrop(id, status, index) {
  const moved = tasks.find((t) => t.id === id);
  if (!moved) return;
  const others = tasks.filter((t) => t.id !== id);
  const group = others.filter((t) => !t.done && t.status === status);
  let insertAt;
  if (!group.length) {
    insertAt = others.length;
  } else if (index >= group.length) {
    insertAt = others.indexOf(group[group.length - 1]) + 1;
  } else {
    insertAt = others.indexOf(group[index]);
  }
  moved.status = status;
  others.splice(insertAt, 0, moved);
  tasks = others;
}

/* ---------------------------------------------------------------------------
 * Card interactions (click / keyboard) — delegated
 * -------------------------------------------------------------------------*/
boardEl.addEventListener("click", (e) => {
  if (suppressDragClick) return;
  const card = e.target.closest && e.target.closest(".card");
  if (!card || !card.dataset.id) return;
  // Checkbox has its own handler; clicks on it shouldn't open the editor.
  if (e.target.closest(".check")) return;
  if (e.target.closest(".email-chip")) return;
  openEditor(card.dataset.id);
});

boardEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest && e.target.closest(".card");
  if (!card || !card.dataset.id) return;
  if (e.target !== card) return; // don't hijack the checkbox
  e.preventDefault();
  openEditor(card.dataset.id);
});

/* ---------------------------------------------------------------------------
 * Email open
 * -------------------------------------------------------------------------*/
async function openEmail(task) {
  if (!task.email) {
    toast("This task is not linked to an email", true);
    return;
  }
  try {
    await tbOpenEmail(task);
  } catch (err) {
    toast(((err && err.message) || "Couldn't open the email"), true);
  }
}

/* ---------------------------------------------------------------------------
 * Task dialog
 * -------------------------------------------------------------------------*/
const fTitle = $("#fTitle");
const fStatus = $("#fStatus");
const fDue = $("#fDue");
const fTime = $("#fTime");
const fRepeat = $("#fRepeat");
const fNotes = $("#fNotes");
const emailBox = $("#emailBox");
const emailMeta = $("#emailMeta");
const dialogError = $("#dialogError");
const icsBtn = $("#icsBtn");
const deleteBtn = $("#deleteBtn");
let deleteArmed = false;
let deleteTimer = null;

function showDialogError(msg) {
  if (msg) {
    dialogError.textContent = msg;
    dialogError.classList.remove("hidden");
  } else {
    dialogError.textContent = "";
    dialogError.classList.add("hidden");
  }
}

function updateIcsButton() {
  const hasDue = !!tbParseDateOnly(fDue.value);
  icsBtn.disabled = !hasDue;
  icsBtn.title = hasDue
    ? "Download this task's due date as a calendar event"
    : "Set a due date first";
  icsBtn.style.opacity = hasDue ? "" : "0.5";
}

function resetDeleteButton() {
  deleteArmed = false;
  deleteBtn.textContent = "Delete";
  deleteBtn.classList.remove("armed");
  if (deleteTimer) {
    clearTimeout(deleteTimer);
    deleteTimer = null;
  }
}

const fNotesLabel = $("#fNotesLabel");

/** Switch the dialog between task and note editing (same form, fewer fields). */
function applyDialogMode(mode) {
  dialogMode = mode === "note" ? "note" : "task";
  form.classList.toggle("note-mode", dialogMode === "note");
  if (fNotesLabel) {
    fNotesLabel.textContent = dialogMode === "note" ? "Text" : "Notes";
  }
  fNotes.placeholder = dialogMode === "note"
    ? "The note itself\u2026"
    : "Optional details\u2026";
}

function openEditor(taskId, presetStatus) {
  applyDialogMode("task");
  editingId = taskId || null;
  editingNoteId = null;
  const task = taskId ? tasks.find((t) => t.id === taskId) : null;
  $("#dialogTitle").textContent = task ? "Edit task" : "New task";
  fTitle.value = task ? task.title : "";
  fStatus.value = task ? task.status : (presetStatus || "medium");
  fDue.value = task && task.due ? task.due : "";
  fTime.value = task && task.dueTime ? task.dueTime : "";
  fRepeat.value = task && TB_REPEATS.includes(task.repeat) ? task.repeat : "none";
  fNotes.value = task ? task.notes : "";
  showDialogError("");
  resetDeleteButton();

  if (task && task.email) {
    emailBox.classList.remove("hidden");
    const bits = [];
    if (task.email.author) bits.push(task.email.author);
    if (task.email.date) {
      const d = new Date(task.email.date);
      if (!isNaN(d)) bits.push(d.toLocaleString());
    }
    bits.push(task.email.subject || "(no subject)");
    emailMeta.textContent = bits.join("  ·  ");
  } else {
    emailBox.classList.add("hidden");
    emailMeta.textContent = "";
  }

  deleteBtn.classList.toggle("hidden", !task);
  updateIcsButton();
  if (!dialog.open) dialog.showModal();
  fTitle.focus();
  fTitle.setSelectionRange(fTitle.value.length, fTitle.value.length);
}

/** Open the same dialog as an editor for a note (new when noteId is null). */
function openNoteEditor(noteId) {
  applyDialogMode("note");
  editingId = null;
  const note = noteId ? notes.find((n) => n.id === noteId) : null;
  editingNoteId = note ? note.id : null;
  $("#dialogTitle").textContent = note ? "Edit note" : "New note";
  fTitle.value = note ? note.title : "";
  fNotes.value = note ? note.text : "";
  fStatus.value = "medium";
  fDue.value = "";
  fTime.value = "";
  fRepeat.value = "none";
  showDialogError("");
  resetDeleteButton();
  emailBox.classList.add("hidden");
  emailMeta.textContent = "";
  deleteBtn.classList.toggle("hidden", !note);
  updateIcsButton();
  if (!dialog.open) dialog.showModal();
  fTitle.focus();
  fTitle.setSelectionRange(fTitle.value.length, fTitle.value.length);
}

function closeEditor() {
  if (dialog.open) dialog.close();
  editingId = null;
  editingNoteId = null;
  applyDialogMode("task");
  resetDeleteButton();
  showDialogError("");
  if (pendingReload) {
    pendingReload = false;
    renderBoard();
  }
}

/** Validate + save the note currently in the dialog. */
async function saveNoteFromDialog() {
  const title = fTitle.value.trim();
  if (!title) {
    showDialogError("Give the note a title.");
    fTitle.focus();
    return;
  }
  const text = fNotes.value;

  if (editingNoteId) {
    const note = notes.find((n) => n.id === editingNoteId);
    if (!note) {
      showDialogError("That note no longer exists.");
      return;
    }
    note.title = title;
    note.text = text;
    note.updatedAt = new Date().toISOString();
    try {
      await persistNotes();
    } catch (_) { return; }
    closeEditor();
    renderNotes();
    toast("Note saved");
  } else {
    const note = tbNormalizeNote({
      id: tbUuid(),
      title,
      text,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    });
    if (!note) {
      showDialogError("Could not create the note.");
      return;
    }
    notes.unshift(note);
    try {
      await persistNotes();
    } catch (_) {
      notes = notes.filter((n) => n.id !== note.id);
      return;
    }
    closeEditor();
    renderNotes();
    toast("Note kept");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (dialogMode === "note") {
    await saveNoteFromDialog();
    return;
  }
  const title = fTitle.value.trim();
  if (!title) {
    showDialogError("Give the task a title.");
    fTitle.focus();
    return;
  }
  const due = fDue.value ? fDue.value : null;
  if (due && !tbParseDateOnly(due)) {
    showDialogError("That due date isn't valid.");
    return;
  }
  const dueTime = fTime.value && tbValidTime(fTime.value) ? fTime.value : null;
  const status = TB_STATUSES.includes(fStatus.value) ? fStatus.value : "medium";
  const repeat = TB_REPEATS.includes(fRepeat.value) ? fRepeat.value : "none";
  if (repeat !== "none" && !due) {
    showDialogError("A repeating task needs a due date — that's the date it repeats from.");
    fDue.focus();
    return;
  }

  if (editingId) {
    const task = tasks.find((t) => t.id === editingId);
    if (!task) {
      showDialogError("That task no longer exists.");
      return;
    }
    const dueChanged = task.due !== due || task.dueTime !== dueTime;
    task.title = title;
    task.notes = fNotes.value;
    task.status = status;
    task.due = due;
    task.dueTime = dueTime;
    task.repeat = repeat;
    // New due value => a fresh reminder is allowed to fire, and any snooze
    // taken on the old due value no longer applies.
    if (dueChanged) {
      task.notifiedAt = null;
      task.snoozeUntil = null;
    }
    try {
      await persist();
    } catch (_) { return; }
    closeEditor();
    renderBoard();
    toast("Task saved");
  } else {
    const task = tbNormalizeTask({
      id: tbUuid(),
      title,
      notes: fNotes.value,
      status,
      due,
      dueTime,
      repeat,
      done: false,
      doneAt: null,
      createdAt: new Date().toISOString(),
      notifiedAt: null,
      email: null,
    });
    if (!task) {
      showDialogError("Could not create the task.");
      return;
    }
    insertAtEndOfStatus(task);
    try {
      await persist();
    } catch (_) {
      tasks = tasks.filter((t) => t.id !== task.id);
      return;
    }
    closeEditor();
    renderBoard();
    toast("Task created");
  }
});

/** Place a brand-new task at the bottom of its status column. */
function insertAtEndOfStatus(task) {
  const group = tasks.filter((t) => !t.done && t.status === task.status);
  const at = group.length
    ? tasks.indexOf(group[group.length - 1]) + 1
    : tasks.length;
  tasks.splice(at, 0, task);
}

deleteBtn.addEventListener("click", async () => {
  // Same armed-confirm flow for both kinds of record.
  if (dialogMode === "note") {
    if (!editingNoteId) return;
    if (!deleteArmed) {
      deleteArmed = true;
      deleteBtn.textContent = "Really delete?";
      deleteBtn.classList.add("armed");
      deleteTimer = setTimeout(resetDeleteButton, 3000);
      return;
    }
    const noteId = editingNoteId;
    const idx = notes.findIndex((n) => n.id === noteId);
    if (idx < 0) {
      closeEditor();
      return;
    }
    const removed = notes[idx];
    notes = notes.filter((n) => n.id !== noteId);
    try {
      await persistNotes();
    } catch (_) {
      notes.splice(Math.min(idx, notes.length), 0, removed); // put it back
      return;
    }
    closeEditor();
    renderNotes();
    toast("Note deleted");
    return;
  }

  if (!editingId) return;
  if (!deleteArmed) {
    deleteArmed = true;
    deleteBtn.textContent = "Really delete?";
    deleteBtn.classList.add("armed");
    deleteTimer = setTimeout(resetDeleteButton, 3000);
    return;
  }
  const id = editingId;
  const removed = tasks.filter((t) => t.id === id);
  tasks = tasks.filter((t) => t.id !== id);
  try {
    await persist();
  } catch (_) {
    tasks = tasks.concat(removed); // put it back; save failed
    return;
  }
  closeEditor();
  renderBoard();
  toast("Task deleted");
});

$("#cancelBtn").addEventListener("click", closeEditor);

dialog.addEventListener("cancel", () => {
  // Escape pressed — normalize state after the dialog closes itself.
  editingId = null;
  editingNoteId = null;
  applyDialogMode("task");
  resetDeleteButton();
  showDialogError("");
  if (pendingReload) {
    pendingReload = false;
    renderBoard();
  }
});

$("#openEmailBtn").addEventListener("click", async () => {
  const task = editingId ? tasks.find((t) => t.id === editingId) : null;
  if (task) await openEmail(task);
});

icsBtn.addEventListener("click", () => {
  const due = fDue.value ? fDue.value : null;
  if (!due) return;
  // Build a task-shaped object from the form so the export matches what's
  // about to be saved (works for both new and edited tasks).
  const draft = {
    id: editingId || tbUuid(),
    title: fTitle.value.trim() || "(untitled)",
    notes: fNotes.value,
    status: fStatus.value,
    due,
    dueTime: fTime.value && tbValidTime(fTime.value) ? fTime.value : null,
    done: false,
  };
  const ics = tbIcsForTask(draft);
  if (!ics) {
    showDialogError("Set a due date before exporting to a calendar.");
    return;
  }
  const safe = (draft.title || "task").replace(/[^\w\- ]+/g, "_").slice(0, 60);
  tbDownloadText(`${safe}.ics`, ics, "text/calendar;charset=utf-8");
  toast("Calendar file downloaded — open it to add the event in Thunderbird");
});

fDue.addEventListener("change", updateIcsButton);

$("#newTaskBtn").addEventListener("click", () => openEditor(null, "medium"));
$("#newNoteBtn").addEventListener("click", () => openNoteEditor(null));

/* ---------------------------------------------------------------------------
 * Publish calendar (task-board.ics)
 *
 * The file mirrors every dated, open task as a VTODO. With ics_server.py
 * running locally, POST it there so Thunderbird's subscribed calendar picks
 * changes up on its next refresh; otherwise fall back to a download the
 * user can import or serve themselves.
 * -------------------------------------------------------------------------*/
const TB_ICS_PUBLISH_URL = "http://127.0.0.1:8899/task-board.ics";

async function publishCalendar() {
  const ics = tbIcsCalendar(tasks);
  const datedCount = tasks.filter((t) => !t.done && t.due).length;
  if (!datedCount) {
    toast("No tasks with due dates yet — set a due date first", true);
    return;
  }

  // Sending the calendar off this machine is opt-in (Preferences). Without the
  // preference the button just hands the file to the user; no request is made.
  const settings = await tbLoadSettings();
  if (!settings.publishToLocalServer) {
    tbDownloadText("task-board.ics", ics, "text/calendar;charset=utf-8");
    toast("Calendar downloaded. To send it to your local feed server instead, tick the box in the add-on's Preferences.", true);
    return;
  }

  try {
    const resp = await fetch(TB_ICS_PUBLISH_URL, {
      method: "POST",
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
      body: ics,
    });
    if (!resp.ok) throw new Error("server answered HTTP " + resp.status);
    toast(`Published ${datedCount} task(s) to task-board.ics — Thunderbird refreshes the calendar on its own schedule (or right-click it → Refresh)`);
  } catch (_) {
    tbDownloadText("task-board.ics", ics, "text/calendar;charset=utf-8");
    toast("Local calendar server not reachable — downloaded task-board.ics instead (import it, or run ics_server.py and subscribe — see README)", true);
  }
}

$("#publishBtn").addEventListener("click", () => {
  publishCalendar().catch((err) =>
    toast("Publish failed: " + ((err && err.message) || err), true)
  );
});

/* ---------------------------------------------------------------------------
 * Full JSON backup: tasks + notes, preserving all extension data fields.
 * Import merges by record ID; destination data wins ID conflicts so re-importing
 * the same file is safe and cannot overwrite newer records.
 * -------------------------------------------------------------------------*/
const backupFileInput = $("#backupFile");

function exportBackup() {
  const backup = {
    format: "perch-task-board-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks,
    notes,
  };
  tbDownloadText(
    `perch-task-board-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(backup, null, 2) + "\n",
    "application/json;charset=utf-8"
  );
  toast(`Backup downloaded: ${tasks.length} task(s) and ${notes.length} note(s)`);
}

function validateBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.format !== "perch-task-board-backup" || value.version !== 1 ||
      !Array.isArray(value.tasks) || !Array.isArray(value.notes)) {
    throw new Error("This is not a supported Perch Task Board backup.");
  }
  if (value.tasks.length > 10000 || value.notes.length > 10000) {
    throw new Error("The backup contains too many records to import safely.");
  }

  const importedTasks = value.tasks.map((record, i) => {
    const task = tbNormalizeTask(record);
    if (!task || !task.title) throw new Error(`Task ${i + 1} is missing a valid ID or title.`);
    return task;
  });
  const importedNotes = value.notes.map((record, i) => {
    const note = tbNormalizeNote(record);
    if (!note || !note.title) throw new Error(`Note ${i + 1} is missing a valid ID or title.`);
    return note;
  });

  const taskIds = new Set();
  for (const task of importedTasks) {
    if (taskIds.has(task.id)) throw new Error(`The backup contains duplicate task ID “${task.id}”.`);
    taskIds.add(task.id);
  }
  const noteIds = new Set();
  for (const note of importedNotes) {
    if (noteIds.has(note.id)) throw new Error(`The backup contains duplicate note ID “${note.id}”.`);
    noteIds.add(note.id);
  }
  return { tasks: importedTasks, notes: importedNotes };
}

async function importBackupFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    toast("Backup file is larger than 20 MB", true);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_) {
    toast("Could not read the backup — make sure it is valid JSON", true);
    return;
  }

  let imported;
  try {
    imported = validateBackup(parsed);
  } catch (err) {
    toast(((err && err.message) || "Backup validation failed"), true);
    return;
  }

  const existingTaskIds = new Set(tasks.map((task) => task.id));
  const existingNoteIds = new Set(notes.map((note) => note.id));
  const newTasks = imported.tasks.filter((task) => !existingTaskIds.has(task.id));
  const newNotes = imported.notes.filter((note) => !existingNoteIds.has(note.id));
  if (!newTasks.length && !newNotes.length) {
    toast("Nothing new to import — all backup records are already here");
    return;
  }

  const mergedTasks = tasks.concat(newTasks);
  const mergedNotes = notes.concat(newNotes);
  try {
    if (!TBApi || !TBApi.storage || !TBApi.storage.local) {
      throw new Error("Thunderbird storage is unavailable");
    }
    await TBApi.storage.local.set({ [TB_TASKS_KEY]: mergedTasks, [TB_NOTES_KEY]: mergedNotes });
  } catch (err) {
    toast("Import save failed: " + ((err && err.message) || err), true);
    return;
  }
  tasks = mergedTasks;
  notes = mergedNotes;
  if (TBApi && TBApi.runtime && typeof TBApi.runtime.sendMessage === "function") {
    try {
      await TBApi.runtime.sendMessage({ command: "resync" });
    } catch (_) { /* storage.onChanged also schedules a background resync */ }
  }

  if (dialog.open) {
    pendingReload = true;
  } else {
    renderBoard();
  }
  toast(`Imported ${newTasks.length} task(s) and ${newNotes.length} note(s); existing records were kept`);
}

$("#exportBackupBtn").addEventListener("click", exportBackup);
$("#importBackupBtn").addEventListener("click", () => {
  backupFileInput.value = "";
  backupFileInput.click();
});
backupFileInput.addEventListener("change", () => {
  importBackupFile(backupFileInput.files && backupFileInput.files[0])
    .catch((err) => toast("Import failed: " + ((err && err.message) || err), true));
});

$("#doneToggle").addEventListener("click", () => {
  const list = $("#doneList");
  const open = list.classList.contains("hidden");
  if (open) {
    list.dataset.open = "1";
    list.classList.remove("hidden");
  } else {
    list.dataset.open = "0";
    list.classList.add("hidden");
  }
  $("#doneToggle").setAttribute("aria-expanded", String(open));
});

$("#clearDoneBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Really clear?";
    setTimeout(() => {
      btn.dataset.armed = "0";
      btn.textContent = "Clear done";
    }, 3000);
    return;
  }
  btn.dataset.armed = "0";
  btn.textContent = "Clear done";
  clearDone();
});

/* ---------------------------------------------------------------------------
 * Live updates: background/context-menu writes + our own echoes
 * -------------------------------------------------------------------------*/
if (TBApi && TBApi.storage && TBApi.storage.onChanged) {
  TBApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const hasTasks = Object.prototype.hasOwnProperty.call(changes, TB_TASKS_KEY);
    const hasNotes = Object.prototype.hasOwnProperty.call(changes, TB_NOTES_KEY);
    if (!hasTasks && !hasNotes) return;
    if (hasTasks) {
      tbLoadTasks().then((fresh) => {
        tasks = fresh;
        rerender();
      });
    }
    if (hasNotes) {
      tbLoadNotes().then((fresh) => {
        notes = fresh;
        rerender();
      });
    }
  });
}

/* ---------------------------------------------------------------------------
 * Init
 * -------------------------------------------------------------------------*/
(async function init() {
  tasks = await tbLoadTasks();
  notes = await tbLoadNotes();
  renderBoard();
})().catch((err) => {
  console.error("[Perch] init failed:", err);
  toast("Failed to load tasks: " + ((err && err.message) || err), true);
});
