#!/usr/bin/env python3
"""
Writes MANIFEST.txt — every file this release contains.

Run before packaging. tools/prune_stale.py reads it to tell a leftover from
something the user added, and tests/shell.test.js reads it so the expected set
of test files is derived rather than hand-maintained in two places.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {"node_modules", ".git", "build", ".gradle", "__pycache__",
             ".ruff_cache", "dist", "outputs"}
SKIP_FILES = {"settings.json", "local.properties", "package-lock.json", "MANIFEST.txt"}
SKIP_SUFFIX = (".pyc", ".keystore", ".jks", ".log", ".zip")


def collect():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            if name in SKIP_FILES or name.endswith(SKIP_SUFFIX):
                continue
            rel = os.path.relpath(os.path.join(dirpath, name), ROOT).replace(os.sep, "/")
            out.append(rel)
    return sorted(out)


def version():
    import json
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as fh:
        return json.load(fh)["version"]


def main():
    files = collect()
    header = [
        f"# Sandeshika {version()} — every file in this release.",
        "#",
        "# A release archive cannot express a deletion: extracting over a working",
        "# tree adds and overwrites but never removes. This is how the upgrade",
        "# knows which files are leftovers.",
        "#",
        "#   python3 tools/prune_stale.py          list them",
        "#   python3 tools/prune_stale.py --apply  remove them",
        "#",
        "# Regenerate with: python3 tools/make_manifest.py",
        "",
    ]
    with open(os.path.join(ROOT, "MANIFEST.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(header + files) + "\n")
    print(f"MANIFEST.txt — {len(files)} files")
    # MANIFEST.txt itself is excluded above: a manifest that lists itself would
    # need regenerating every time it changed.
    return 0


if __name__ == "__main__":
    sys.exit(main())
