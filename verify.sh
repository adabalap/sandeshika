#!/usr/bin/env bash
# Confirms the project extracted correctly and is buildable BEFORE you push.
# Run from the directory you extracted into:  bash verify.sh
set -uo pipefail
fail=0
say() { printf "  %-6s %s\n" "$1" "$2"; }
need() { if [ -e "$2" ]; then say OK "$2"; else say MISSING "$2"; fail=1; fi }

echo "Gradle build files"
need f settings.gradle.kts
need f build.gradle.kts
need f gradle.properties
need f gradlew
need f gradle/wrapper/gradle-wrapper.jar
need f gradle/wrapper/gradle-wrapper.properties

echo; echo "App module"
need f app/build.gradle.kts
need f app/src/main/AndroidManifest.xml
need f app/src/main/java/com/adabala/sandeshika/MainActivity.kt
need f app/src/main/java/com/adabala/sandeshika/MedhaBridge.kt

echo; echo "Web assets"
for f in index.html app.css icon.svg js/bridge.js js/parser.js js/api.js js/app.js; do
  need f "app/src/main/assets/web/$f"
done

echo; echo "Resources"
for f in values/strings.xml values/themes.xml xml/data_extraction_rules.xml \
         drawable/ic_launcher_background.xml drawable/ic_launcher_foreground.xml \
         mipmap-anydpi-v26/ic_launcher.xml mipmap-anydpi-v26/ic_launcher_round.xml; do
  need f "app/src/main/res/$f"
done

echo; echo "Hygiene"
if [ -x gradlew ]; then say OK "gradlew is executable"
else say FIX "chmod +x gradlew"; fi

ODD=$(find . -name '*[{}]*' -not -path './.git/*' 2>/dev/null | head -5)
if [ -n "$ODD" ]; then
  say BAD "filenames containing braces (some extractors fail on these):"
  echo "$ODD" | sed 's/^/         /'
  fail=1
else
  say OK "no problematic filenames"
fi

if [ -d sandeshika-apk ]; then
  say BAD "nested sandeshika-apk/ found — flatten it, Gradle only reads the root"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "Ready. Next:  git add -A && git commit -m 'Sandeshika APK' && git push"
else
  echo "Fix the items above before pushing."
  exit 1
fi
