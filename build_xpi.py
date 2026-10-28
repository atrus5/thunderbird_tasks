#!/usr/bin/env python3
"""Build perch-task-board-<version>.xpi from the extension files.

An .xpi is just a zip with manifest.json at the archive root (no
enclosing folder). Run:

    python build_xpi.py

It packages only the files Thunderbird needs (no README, no editor
cruft), then verifies the archive: zip integrity, manifest at root,
every JS file passes `node --check`, and every local script/stylesheet
referenced by the HTML is present.
"""

import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
LEGACY_ADDON_ID = "task-board@example.com"

# Everything Thunderbird loads, in load order for the background page.
FILES = [
    "manifest.json",
    "storage.js",
    "background.js",
    "dev_shim.js",   # guarded: only loads when `browser` is undefined (plain-browser preview)
    "board.html",
    "board.css",
    "board.js",
    "reminder.html",   # the in-app reminder popup window (background.js)
    "reminder.css",
    "reminder.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "icons/icon.svg",
]


def main() -> int:
    legacy_id_build = "--legacy-id" in sys.argv[1:]
    unexpected = [arg for arg in sys.argv[1:] if arg != "--legacy-id"]
    if unexpected:
        print("Unknown option(s):", ", ".join(unexpected))
        return 2

    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if legacy_id_build:
        out = HERE / f"task-board-migration-{version}.xpi"
        manifest["name"] = "Task Board Data Transfer"
        manifest.setdefault("browser_specific_settings", {}).setdefault("gecko", {})["id"] = LEGACY_ADDON_ID
    else:
        out = HERE / f"perch-task-board-{version}.xpi"

    missing = [f for f in FILES if not (HERE / f).is_file()]
    if missing:
        print("MISSING SOURCE FILES:", ", ".join(missing))
        return 1

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            if f == "manifest.json" and legacy_id_build:
                z.writestr(f, json.dumps(manifest, indent=2) + "\n")
            else:
                z.write(HERE / f, f)

    fail = []
    tmp = pathlib.Path(tempfile.mkdtemp())
    try:
        with zipfile.ZipFile(out) as z:
            if z.testzip() is not None:
                fail.append("corrupt zip entry")
            z.extractall(tmp)
            names = set(z.namelist())

        if "manifest.json" not in names:
            fail.append("manifest.json not at archive root")

        man = json.loads((tmp / "manifest.json").read_text(encoding="utf-8"))

        has_node = shutil.which("node") is not None
        if not has_node:
            print("note: node not found — skipping JS syntax check")
        for f in sorted(n for n in names if n.endswith(".js")):
            if not has_node:
                break
            r = subprocess.run(["node", "--check", str(tmp / f)],
                               capture_output=True, text=True)
            if r.returncode:
                first = (r.stderr or r.stdout).strip().splitlines()[0]
                fail.append(f"{f}: {first}")

        for h in sorted(n for n in names if n.endswith(".html")):
            html = (tmp / h).read_text(encoding="utf-8")
            for ref in re.findall(r'(?:src|href)="([^"]+)"', html):
                if not ref.startswith(("http", "#")) and ref not in names:
                    fail.append(f"{h} references missing {ref}")

        for s in man.get("background", {}).get("scripts", []):
            if s not in names:
                fail.append(f"manifest background script missing: {s}")

        if "README.md" in names:
            fail.append("README.md should not ship")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if fail:
        print("BUILD FAILED:")
        for m in fail:
            print(" -", m)
        return 1

    build_kind = "legacy-ID migration" if legacy_id_build else "Perch release"
    print(f"OK {out.name}  ({man['name']} {version}, {build_kind}, "
          f"{out.stat().st_size} bytes, {len(FILES)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
