// dev_shim.js — localStorage-backed stand-in for Thunderbird's `browser`
// API, used ONLY when board.html / popup.html are opened in a plain browser
// (local preview / manual testing). In Thunderbird `browser` already exists
// and the HTML pages skip this file entirely (see the loader script tag).
"use strict";

(function () {
  if (typeof browser !== "undefined") return; // real extension runtime

  const STORE_KEY = "taskboard.dev.v1";
  const alarmLog = [];
  // Reminder telemetry for the preview: background.js runs here too (when
  // injected for a test), so record what it asked the OS/Thunderbird to show.
  const notificationLog = [];
  const windowLog = [];
  let nextWindowId = 100;

  function readAll() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch (_) {
      return {};
    }
  }

  function writeAll(obj) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(obj));
    } catch (err) {
      console.error("[dev_shim] storage write failed:", err);
    }
  }

  const storageListeners = [];

  const browserShim = {
    storage: {
      local: {
        async get(keys) {
          const all = readAll();
          if (keys == null) return all;
          if (typeof keys === "string") {
            return { [keys]: all[keys] };
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = all[k];
            return out;
          }
          // Object with defaults
          const out = {};
          for (const [k, v] of Object.entries(keys)) {
            out[k] = Object.prototype.hasOwnProperty.call(all, k) ? all[k] : v;
          }
          return out;
        },
        async set(items) {
          const all = readAll();
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: all[k], newValue: v };
            all[k] = v;
          }
          writeAll(all);
          for (const fn of storageListeners) {
            try { fn(changes, "local"); } catch (_) { /* ignore */ }
          }
        },
        async remove(keys) {
          const all = readAll();
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const k of list) {
            changes[k] = { oldValue: all[k], newValue: undefined };
            delete all[k];
          }
          writeAll(all);
          for (const fn of storageListeners) {
            try { fn(changes, "local"); } catch (_) { /* ignore */ }
          }
        },
      },
      onChanged: {
        addListener(fn) { storageListeners.push(fn); },
      },
    },

    runtime: {
      getURL(path) { return path; },
      onMessage: { addListener() { /* no background page in preview */ } },
      onInstalled: { addListener() {} },
      async sendMessage() { return { ok: true }; },
    },

    alarms: {
      async create(name, info) {
        alarmLog.push({ name, info });
      },
      async clear(name) {
        const i = alarmLog.findIndex((a) => a.name === name);
        if (i >= 0) alarmLog.splice(i, 1);
        return true;
      },
      async clearAll() { alarmLog.length = 0; },
      async getAll() { return alarmLog.slice(); },
      onAlarm: { addListener() {} },
    },

    notifications: {
      async create(id, opts) {
        notificationLog.push({ id, opts });
        console.info("[dev_shim] notification:", id, opts);
        return id;
      },
      onClicked: { addListener() {} },
    },

    menus: {
      create() {},
      update() {},
      remove() {},
      refresh() {},
      onShown: { addListener() {} },
      onClicked: { addListener() {} },
    },

    tabs: {
      async query() { return []; },
      async create(details) {
        console.info("[dev_shim] tabs.create:", details);
        return { id: 1 };
      },
      async update(tabId, details) {
        console.info("[dev_shim] tabs.update:", tabId, details);
        return { id: tabId };
      },
    },

    windows: {
      async update() { return {}; },
      async create(details) {
        const id = nextWindowId++;
        windowLog.push({ id, details });
        console.info("[dev_shim] windows.create:", details);
        return { id, tabs: [{ id: id + 1 }] };
      },
      // No real windows in a plain browser: report the one we recorded as
      // still open so background.js's reuse path can be exercised.
      async get(id) {
        const hit = windowLog.find((w) => w.id === id);
        return hit ? { id: hit.id, tabs: [{ id: hit.id + 1 }] } : null;
      },
      onRemoved: { addListener() {} },
      onCreated: { addListener() {} },
    },

    browserAction: {
      async setBadgeText(details) {
        console.info("[dev_shim] badge:", details && details.text);
      },
      async setBadgeBackgroundColor() {},
    },

    messageDisplay: {
      // A canned message so the popup's "from this email" path can be
      // exercised in the preview.
      async getDisplayedMessage() {
        return browserShim.messageDisplay._sample;
      },
      async getDisplayedMessages() {
        return browserShim.messageDisplay._sample
          ? [browserShim.messageDisplay._sample]
          : [];
      },
      async open(details) {
        console.info("[dev_shim] messageDisplay.open:", details);
      },
      _sample: {
        id: 1,
        subject: "Sample invoice #1234 — due next week",
        author: "Billing <billing@example.com>",
        date: new Date("2026-10-12T09:30:00Z"),
        headerMessageId: "<sample-1234@example.com>",
        folder: { accountId: "acct1", path: "/Inbox", name: "Inbox" },
      },
    },

    messages: {
      async get() { return null; },
      async query() { return { messages: [] }; },
    },
  };

  window.browser = browserShim;
  window.__tbShim = {
    reset() {
      localStorage.removeItem(STORE_KEY);
      alarmLog.length = 0;
      notificationLog.length = 0;
      windowLog.length = 0;
    },
    alarms: alarmLog,
    notifications: notificationLog,
    windows: windowLog,
  };
})();
