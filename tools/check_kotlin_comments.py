#!/usr/bin/env python3
"""
Fails when a Kotlin block comment swallows code.

THE BUG THIS EXISTS FOR

Kotlin block comments NEST. A glob pattern written inside one — anything
containing a slash-star sequence, which is most path patterns — opens a nested
comment. The closing delimiter then only closes the inner one, and the outer
comment keeps swallowing real code until it happens to meet a stray closing
sequence, typically inside a string literal many lines below.

The result is a parse error reported nowhere near the actual mistake. It cost a
full CI build cycle to locate:

    /*
     *   assets/static/**      <- opens a NESTED comment
     */                        <- closes only the nested one
    exclude("**/.DS_Store", "**/*.map")
                        ^ the outer comment finally ends inside this string,
                          and the rest of the line is parsed as code

This lexer tracks nesting, line comments, strings and raw strings, so it sees
what the compiler sees. Use line comments when a comment needs to mention a
glob.

    python3 tools/check_kotlin_comments.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def scan(path):
    """Returns [(line, message)] for anything the Kotlin lexer would trip on."""
    with open(path, encoding="utf-8") as fh:
        src = fh.read()

    i, n, line, depth = 0, len(src), 1, 0
    opened = []
    nested = []

    while i < n:
        ch = src[i]
        if ch == "\n":
            line += 1
            i += 1
            continue

        if depth > 0:
            if src.startswith("/*", i):
                depth += 1
                opened.append(line)
                nested.append(line)
                i += 2
                continue
            if src.startswith("*/", i):
                depth -= 1
                opened.pop()
                i += 2
                continue
            i += 1
            continue

        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            depth = 1
            opened.append(line)
            i += 2
            continue
        if src.startswith('"""', i):
            j = src.find('"""', i + 3)
            if j < 0:
                return [(line, "unterminated raw string")]
            line += src.count("\n", i, j)
            i = j + 3
            continue
        if ch == '"':
            i += 1
            while i < n and src[i] != '"':
                if src[i] == "\\":
                    i += 1
                i += 1
            i += 1
            continue
        i += 1

    problems = []
    if depth:
        problems.append((opened[0], f"block comment opened here is never closed (depth {depth})"))
    for ln in nested:
        problems.append((ln, "a nested block comment opens here — usually a glob pattern "
                             "inside a comment. Use // line comments instead."))
    return problems


def main():
    bad = 0
    checked = 0
    # os.walk rather than glob: a recursive glob joined onto an absolute root
    # silently matched nothing here, and a checker that reports "OK - 0 files"
    # is worse than no checker at all.
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames
                       if d not in ("build", "node_modules", ".git", ".gradle")]
        for name in filenames:
            if name.endswith((".kt", ".kts")):
                files.append(os.path.join(dirpath, name))

    for rel in sorted(files):
        if True:
            checked += 1
            for ln, msg in scan(rel):
                bad += 1
                print(f"{os.path.relpath(rel, ROOT)}:{ln}: {msg}")

    # Finding nothing to check is a failure, not a pass.
    if checked == 0:
        print("No Kotlin files found — this checker is not actually checking anything.")
        return 1
    if bad:
        print(f"\n{bad} problem(s) across {checked} Kotlin file(s).")
        return 1
    print(f"OK — comments balance in {checked} Kotlin file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
