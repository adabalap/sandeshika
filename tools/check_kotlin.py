#!/usr/bin/env python3
"""
Compiles the Kotlin sources without an Android classpath and reports every
error that is not explainable by the missing classpath.

## Why the filtering polarity matters

Compiling here always produces thousands of "unresolved reference" errors,
because android.jar, Compose and the AndroidX libraries are absent. Real
errors have to be separated from that noise somehow, and there are two ways
to do it.

The obvious one is to grep for error patterns you expect: "expecting",
"unclosed", "redeclaration". That is an allowlist, and it silently hides
every error class you failed to think of. It did exactly that here -- a
`when` over an enum stopped being exhaustive after two categories were added,
the compiler said so plainly, and the grep dropped the message because
"must be exhaustive" was not on the list. CI caught it three minutes later.

So this denylists instead. Anything the missing classpath can explain is
dropped; everything else is shown. Unknown error classes surface by default,
which is the only way a check like this stays useful as the code changes.

Usage: python3 tools/check_kotlin.py
Requires kotlinc on PATH; exits 0 with a note if it is absent.
"""
import glob
import re
import shutil
import subprocess
import sys
import tempfile

# Errors that are purely artefacts of compiling without android.jar, Compose,
# and the AndroidX libraries. Each needs a reason, so that nothing is added
# here just to make the output quiet.
CLASSPATH_NOISE = [
    # The dependency itself is missing, so its symbols cannot resolve.
    r"unresolved reference",
    # Follows directly from an unresolved receiver type.
    r"cannot infer type for this parameter",
    r"cannot infer a type for this parameter",
    # A superclass from android.jar is absent, so its members are unknown.
    r"overrides nothing",
    r"'.*' hides member of supertype",
    # Overload sets are incomplete when half the candidates live in an
    # absent library.
    r"overload resolution ambiguity",
    r"none of the following (functions|candidates) can be called",
    # Annotations from absent libraries.
    r"this class does not have a constructor",
    r"annotation argument must be a compile-time constant",
    # Generic inference collapses once any type in the expression is absent:
    # `"Info" to Color(...)` cannot infer Pair's second parameter when Color
    # does not exist. These are consequences, never causes.
    r"not enough information to infer type argument",
    r"function '(component\d+|\w+)\(\)' is ambiguous",
    r"argument type mismatch",
    r"operator '.*' cannot be applied",
    r"comparison of incompatible enums",
    r"smart cast to .* is impossible",
    r"function invocation '.*' expected",
    # Compose compiler plugin is not running in this invocation.
    r"@composable",
    r"composable invocations can only happen",
]


def main():
    if not shutil.which("kotlinc"):
        print("kotlinc not on PATH - skipping. Install it to run this check.")
        return 0

    sources = sorted(
        glob.glob("app/src/main/java/**/*.kt", recursive=True)
        + glob.glob("core/**/src/main/java/**/*.kt", recursive=True)
    )
    if not sources:
        print("no Kotlin sources found")
        return 1

    with tempfile.TemporaryDirectory() as out:
        proc = subprocess.run(
            ["kotlinc", "-nowarn", "-d", out] + sources,
            capture_output=True,
            text=True,
        )

    noise = re.compile("|".join(CLASSPATH_NOISE), re.IGNORECASE)
    real = [
        line
        for line in (proc.stdout + proc.stderr).splitlines()
        if "error:" in line and not noise.search(line)
    ]

    if real:
        print(f"Kotlin errors not explained by the missing Android classpath ({len(real)}):\n")
        for line in real[:40]:
            print(" ", line.strip())
        if len(real) > 40:
            print(f"  ... and {len(real) - 40} more")
        return 1

    print(f"check_kotlin: OK ({len(sources)} files, no unexplained errors)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
