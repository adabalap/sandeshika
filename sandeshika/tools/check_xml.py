#!/usr/bin/env python3
"""
Parses every XML file in the project with a real parser.

Exists because one specific mistake has recurred five times across this
codebase: a literal "--" inside an XML comment. It is illegal anywhere in a
comment body per the spec, invisible to a human skim, and surfaces only when
aapt2 parses resources partway through a Gradle build -- which on this
project means a push, a CI queue and a Gradle download before anyone finds
out.

Usage: python3 tools/check_xml.py
"""
import glob
import sys
import xml.dom.minidom

def main():
    files = sorted(glob.glob("**/*.xml", recursive=True))
    files = [f for f in files if "/build/" not in f and not f.startswith("build/")]
    bad = []
    for f in files:
        try:
            xml.dom.minidom.parse(f)
        except Exception as e:
            bad.append(f"{f}: {e}")
    if bad:
        print("Malformed XML:\n")
        for b in bad:
            print(" ", b)
        return 1
    print(f"check_xml: OK ({len(files)} files well-formed)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
