#!/usr/bin/env python3
"""Serve task-board.ics to Thunderbird's calendar (ICS subscription).

Thunderbird exposes no calendar API to extensions, so the Perch Task Board
mirrors its dated tasks as VTODOs in a calendar file. This tiny stdlib-only
server makes that file *subscribable*:

    python ics_server.py            # http://127.0.0.1:8899/task-board.ics
    python ics_server.py --port 9000 --dir some/directory

Then in Thunderbird: Calendar tab -> Add Calendar -> On My Network ->
Location: http://127.0.0.1:8899/task-board.ics  (name it "Perch Task Board").

The board's "Publish calendar" button POSTs the current .ics here; the
Thunderbird subscription then refreshes on its own cadence (or right-click
the calendar -> Refresh). Until the first publish, GET answers with an
empty valid calendar so the subscription stays healthy.

Only binds to 127.0.0.1 — this is not meant to be exposed anywhere.
"""

import argparse
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FILENAME = "task-board.ics"
CONTENT_TYPE = "text/calendar; charset=utf-8"
MAX_BODY_BYTES = 5 * 1024 * 1024  # sanity cap for POSTed calendars

EMPTY_CALENDAR = (
    "BEGIN:VCALENDAR\r\n"
    "VERSION:2.0\r\n"
    "PRODID:-//Perch Task Board//ics_server.py//EN\r\n"
    "CALSCALE:GREGORIAN\r\n"
    "METHOD:PUBLISH\r\n"
    "X-WR-CALNAME:Perch Task Board\r\n"
    "END:VCALENDAR\r\n"
).encode("utf-8")


class IcsHandler(BaseHTTPRequestHandler):
    # Set by main() before serving.
    directory = "."

    # -- helpers ---------------------------------------------------------
    def _send(self, status, body, ctype=None, extra_headers=()):
        self.send_response(status)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The board page (a moz-extension:// origin in Thunderbird, or a
        # plain http://127.0.0.1 page in dev) must be able to POST to us.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        for key, value in extra_headers:
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _wants_ics(self):
        return self.path.split("?")[0] in ("", "/", "/" + FILENAME)

    def _ics_path(self):
        return os.path.join(self.directory, FILENAME)

    # -- verbs -----------------------------------------------------------
    def do_OPTIONS(self):
        self._send(204, b"")

    def do_HEAD(self):
        if not self._wants_ics():
            self._send(404, b"", "text/plain; charset=utf-8")
            return
        self._send(200, b"", CONTENT_TYPE)

    def do_GET(self):
        if not self._wants_ics():
            self._send(
                404,
                f"Nothing here. The calendar lives at /{FILENAME}\n".encode(),
                "text/plain; charset=utf-8",
            )
            return
        try:
            with open(self._ics_path(), "rb") as fh:
                data = fh.read()
            self._send(200, data, CONTENT_TYPE)
            print(f"[ics] served {len(data)} bytes")
        except FileNotFoundError:
            # Serve a valid empty calendar so Thunderbird's subscription
            # doesn't turn into an error state before the first publish.
            self._send(200, EMPTY_CALENDAR, CONTENT_TYPE)
            print("[ics] served empty calendar (nothing published yet)")

    def do_POST(self):
        if not self._wants_ics():
            self._send(404, b"", "text/plain; charset=utf-8")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(400, b"bad content length\n", "text/plain; charset=utf-8")
            return
        body = self.rfile.read(length)
        if b"BEGIN:VCALENDAR" not in body[:2048]:
            self._send(
                422,
                b"body does not look like an iCalendar file\n",
                "text/plain; charset=utf-8",
            )
            return
        # Atomic write: temp file in the same directory, then replace.
        target = self._ics_path()
        fd, tmp = tempfile.mkstemp(
            dir=self.directory, prefix=FILENAME, suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(body)
            os.replace(tmp, target)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            self._send(500, b"could not write calendar file\n",
                       "text/plain; charset=utf-8")
            return
        print(f"[ics] published {len(body)} bytes -> {target}")
        self._send(204, b"")

    def log_message(self, fmt, *args):
        # Keep one concise line per request (the default logs full paths).
        sys.stdout.write("[http] %s - %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--dir", default=os.path.dirname(os.path.abspath(__file__)),
                    help="directory where task-board.ics is stored "
                         "(default: next to this script)")
    args = ap.parse_args()

    directory = os.path.abspath(args.dir)
    os.makedirs(directory, exist_ok=True)
    IcsHandler.directory = directory

    server = ThreadingHTTPServer(("127.0.0.1", args.port), IcsHandler)
    print(f"Perch Task Board ICS feed: http://127.0.0.1:{args.port}/{FILENAME}")
    print(f"Calendar file:      {os.path.join(directory, FILENAME)}")
    print("In Thunderbird: Calendar -> Add Calendar -> On My Network ->")
    print(f"  Location: http://127.0.0.1:{args.port}/{FILENAME}")
    print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        server.server_close()


if __name__ == "__main__":
    main()
