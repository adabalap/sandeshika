# Getting this into your repo

**First: check the extraction worked.**

```bash
bash verify.sh
```

It lists every required file and flags the two things that actually go wrong:
a nested folder, and filenames some extractors choke on.

> v1.0.1 shipped with a directory literally named
> `{values,layout,drawable,mipmap-anydpi-v26,xml}` — a shell brace expansion
> that failed and got packaged. Braces and commas break several unzip tools,
> which can abort an extraction part-way and leave files missing. Removed in
> v1.0.2; `verify.sh` now checks for it.


**Extract so that `settings.gradle.kts` sits at the REPOSITORY ROOT.**

```
your-repo/
├── settings.gradle.kts     <-- must be here
├── build.gradle.kts
├── gradlew
├── app/
├── tools/
├── tests/
└── .github/workflows/build-apk.yml
```

Not this:

```
your-repo/
└── sandeshika-apk/         <-- one level too deep; Gradle finds nothing
    └── settings.gradle.kts
```

The v1.0.1 archive is already flat, so:

```bash
cd your-repo
unzip -o sandeshika-apk-v1.0.1.zip
git add -A && git commit -m "feat: Sandeshika as a native APK"
```

If you extracted the earlier archive, flatten it:

```bash
git mv sandeshika-apk/* sandeshika-apk/.[!.]* . && rmdir sandeshika-apk
```

CI now locates the Gradle build up to three levels deep, so a nested layout
still builds — but flat is what everything else assumes.

## The wrapper must be committed

```bash
git ls-files gradle/wrapper/
# expect gradle-wrapper.jar AND gradle-wrapper.properties
```

If the jar is missing, `git add -f gradle/wrapper/gradle-wrapper.jar`. Without
it CI regenerates one, which means the build tool version is not pinned.

Also check `gradlew` is executable:

```bash
git update-index --chmod=+x gradlew
```
