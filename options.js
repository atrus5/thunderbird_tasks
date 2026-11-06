// options.js — the add-on's Preferences page.
//
// One preference today: whether "Publish calendar" may send the generated
// calendar to a server on this computer. It is off by default and the page
// spells out what is sent and where, because that transfer must be something
// the user switches on deliberately (not something the board does on a click
// alone). board.js reads the same preference before it calls fetch().
"use strict";

const optLocalServer = document.getElementById("optLocalServer");
const statusEl = document.getElementById("status");

const ON_TEXT =
  "On — Publish calendar will send task-board.ics to 127.0.0.1:8899.";
const OFF_TEXT =
  "Off — Publish calendar downloads task-board.ics instead. Nothing is sent.";

(function init() {
  tbLoadSettings()
    .then((settings) => {
      optLocalServer.checked = settings.publishToLocalServer;
      statusEl.textContent = settings.publishToLocalServer ? ON_TEXT : OFF_TEXT;
    })
    .catch((err) => {
      console.error("[Perch] reading preferences failed:", err);
      statusEl.textContent =
        "Couldn't read preferences: " + ((err && err.message) || err);
    });
})();

optLocalServer.addEventListener("change", async () => {
  const on = optLocalServer.checked;
  statusEl.textContent = "Saving…";
  try {
    await tbSaveSettings({ publishToLocalServer: on });
    statusEl.textContent = on ? ON_TEXT : OFF_TEXT;
  } catch (err) {
    // Never leave the box claiming something that was not stored.
    optLocalServer.checked = !on;
    statusEl.textContent = "Couldn't save: " + ((err && err.message) || err);
  }
});
