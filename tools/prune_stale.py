#!/usr/bin/env python3
"""
Removes files left behind by a previous version.

THE PROBLEM THIS SOLVES

Extracting a release archive over a working tree adds files and overwrites
files. It never deletes them. So every file removed upstream survives locally,
keeps getting picked up by the test glob and the module graph, and fails with an
error about its own contents rather than about the fact that it should no longer
exist. It has happened twice already:

    tests/e2e_flask.js   replaced by tests/e2e.test.js in 2.1.0
    tests/bridge.test.js never shipped by this project

An archive has no way to say "and delete that". A manifest does. MANIFEST.txt
lists every file this release contains; anything else inside a managed directory
is from an older version, and this reconciles the two.

USAGE

    python3 tools/prune_stale.py            # dry run — lists, changes nothing
    python3 tools/prune_stale.py --apply    # deletes (via git rm when tracked)

DRY RUN IS THE DEFAULT, deliberately. A tool that deletes files on an
accidental invocation is worse than the problem it fixes.
"""
import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "MANIFEST.txt")

# Only these are reconciled.
#
# The repository root itself is NOT managed: it holds settings.json, keystores,
# local.properties and whatever else belongs to the person running this, and
# nothing here should be able to touch them.
MANAGED_DIRS = (
    "static",
    "tests",
    "tools",
    "app/src",
    ".github/workflows",
)

# Never removed, even inside a managed directory.
KEEP = {
    "settings.json",
    "local.properties",
}
KEEP_SUFFIXES = (".keystore", ".jks", ".pyc", ".log")
KEEP_DIRS = ("node_modules", ".git", "build", ".gradle", "__pycache__", ".ruff_cache")


def load_manifest():
    if not os.path.exists(MANIFEST):
        sys.exit(
            "MANIFEST.txt is missing.\n"
            "It ships with the release and lists every file in it. Without it there is\n"
            "no way to tell a leftover from something you added, so this refuses to guess."
        )
    with open(MANIFEST, encoding="utf-8") as fh:
        return {
            line.strip() for line in fh
            if line.strip() and not line.startswith("#")
        }


def walk_managed():
    """Every file currently inside a managed directory, as a repo-relative path."""
    found = set()
    for base in MANAGED_DIRS:
        top = os.path.join(ROOT, base)
        if not os.path.isdir(top):
            continue
        for dirpath, dirnames, filenames in os.walk(top):
            dirnames[:] = [d for d in dirnames if d not in KEEP_DIRS]
            for name in filenames:
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
                if name in KEEP or name.endswith(KEEP_SUFFIXES):
                    continue
                found.add(rel)
    return found


def is_tracked(rel):
    try:
        r = subprocess.run(
            ["git", "ls-files", "--error-unmatch", rel],
            cwd=ROOT, capture_output=True, check=False,
        )
        return r.returncode == 0
    except FileNotFoundError:
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="actually delete. Without this, nothing is changed.")
    args = ap.parse_args()

    shipped = load_manifest()
    present = walk_managed()
    stale = sorted(present - shipped)

    if not stale:
        print("Nothing stale. The working tree matches the release.")
        return 0

    print(f"{len(stale)} file(s) in managed directories are not part of this release:\n")
    for rel in stale:
        print(f"  {rel}")

    if not args.apply:
        print(
            "\nNothing was changed. If these are leftovers from an older version:\n"
            "    python3 tools/prune_stale.py --apply\n"
            "If one of them is yours, move it outside the managed directories\n"
            f"  ({', '.join(MANAGED_DIRS)})\n"
            "or add it to MANIFEST.txt so this stops flagging it."
        )
        return 1

    removed = 0
    for rel in stale:
        full = os.path.join(ROOT, rel)
        try:
            # git rm when the file is tracked, so the deletion is staged and
            # shows up in review rather than as a mysterious missing file.
            if is_tracked(rel):
                subprocess.run(["git", "rm", "-q", "--", rel], cwd=ROOT, check=True)
                print(f"  git rm  {rel}")
            else:
                os.remove(full)
                print(f"  removed {rel}")
            removed += 1
        except Exception as exc:
            print(f"  FAILED  {rel}: {exc}")

    print(f"\n{removed} removed. Run `npm test` to confirm, then review `git status`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
