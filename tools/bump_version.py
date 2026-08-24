#!/usr/bin/env python3
"""
Bumps the version in every place that must agree.

A service worker keyed to a stale cache name serves old code forever, and the
symptom is invisible from inside the app: the repo looks right, the phone runs
something else, and the days that costs are the reason this script exists.

FIVE files have to move together now. The previous version of this script still
pointed at static/js/app.js, which was split into modules in 2.0.0, and did not
know about package.json at all — so it printed a warning nobody read and left
the build half-bumped. tests/shell.test.js fails when the four disagree, which
is the backstop; this is the thing that keeps them in step in the first place.

    python3 tools/bump_version.py 2.1.0
"""
import json
import os
import re
import sys

USAGE = "usage: bump_version.py <major.minor.patch>"

if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
    print(USAGE)
    sys.exit(2)

version = sys.argv[1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EDITS = [
    ("package.json",       r'"version": "[^"]+"',      f'"version": "{version}"'),
    ("static/sw.js",       r"const VERSION = '[^']+';", f"const VERSION = '{version}';"),
    ("static/js/main.js",  r"const BUILD = '[^']+';",   f"const BUILD = '{version}';"),
    ("app.py",             r'APP_VERSION = "[^"]+"',    f'APP_VERSION = "{version}"'),
    ("app/build.gradle.kts", r'val appVersionName = "[^"]+"',
     f'val appVersionName = "{version}"'),
]

failed = []
for rel, pattern, replacement in EDITS:
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        failed.append(f"{rel} does not exist")
        continue
    with open(path, encoding="utf-8") as fh:
        before = fh.read()
    after, count = re.subn(pattern, replacement, before, count=1)
    if not count:
        failed.append(f"{rel} has no version marker matching {pattern}")
        continue
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(after)
    print(f"  {rel} -> {version}")

# A missed file is the whole failure mode this script exists to prevent, so it
# is an error rather than a warning. A warning is something you scroll past.
if failed:
    print("\nFAILED — the versions no longer agree:")
    for f in failed:
        print(f"  {f}")
    sys.exit(1)

# Confirm by reading back, not by trusting the writes above.
with open(os.path.join(root, "package.json"), encoding="utf-8") as fh:
    pkg = json.load(fh)
if pkg["version"] != version:
    print(f"\nFAILED — package.json reads {pkg['version']} after the write.")
    sys.exit(1)

# versionCode must increase monotonically or Android refuses the upgrade. It is
# derived from the name so it can never disagree with it: 2.1.0 -> 20100.
major, minor, patch = (int(x) for x in version.split("."))
code = major * 10000 + minor * 100 + patch
gradle_path = os.path.join(root, "app/build.gradle.kts")
if os.path.exists(gradle_path):
    with open(gradle_path, encoding="utf-8") as fh:
        g = fh.read()
    g, n = re.subn(r"val appVersionCode = \d+", f"val appVersionCode = {code}", g, count=1)
    if not n:
        print("\nFAILED — app/build.gradle.kts has no appVersionCode to update.")
        sys.exit(1)
    with open(gradle_path, "w", encoding="utf-8") as fh:
        fh.write(g)
    print(f"  app/build.gradle.kts versionCode -> {code}")

print(f"\nAll five now read {version}. Run `npm test` to confirm.")
