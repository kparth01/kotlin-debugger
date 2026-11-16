#!/usr/bin/env bash
# Puts Apache Maven into extension/maven, so the VSIX carries its own Maven (used by the Maven view when a
# project has no mvnw and kotlinDebugger.maven.executable is empty). The download is verified against the
# SHA-512 pinned below; nothing is downloaded when that version is already in place.
set -euo pipefail

MAVEN_VERSION=3.9.16
MAVEN_SHA512=831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/extension/maven"
if [[ -f "$TARGET/.version" && "$(cat "$TARGET/.version")" == "$MAVEN_VERSION" && -f "$TARGET/bin/mvn" ]]; then
  echo "    bundled Maven $MAVEN_VERSION is already in extension/maven"
  exit 0
fi

ARCHIVE="apache-maven-$MAVEN_VERSION-bin.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for base in "https://dlcdn.apache.org/maven/maven-3/$MAVEN_VERSION/binaries" "https://archive.apache.org/dist/maven/maven-3/$MAVEN_VERSION/binaries"; do
  if curl -fsSL --retry 2 -o "$TMP/$ARCHIVE" "$base/$ARCHIVE"; then break; fi
done
[[ -s "$TMP/$ARCHIVE" ]] || { echo "Could not download $ARCHIVE" >&2; exit 1; }

if command -v sha512sum >/dev/null; then ACTUAL="$(sha512sum "$TMP/$ARCHIVE" | cut -d' ' -f1)"; else ACTUAL="$(shasum -a 512 "$TMP/$ARCHIVE" | cut -d' ' -f1)"; fi
if [[ "$ACTUAL" != "$MAVEN_SHA512" ]]; then
  echo "SHA-512 of $ARCHIVE does not match the pinned value; not using it." >&2
  exit 1
fi

tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
rm -rf "$TARGET"
mv "$TMP/apache-maven-$MAVEN_VERSION" "$TARGET"
echo "$MAVEN_VERSION" > "$TARGET/.version"
echo "    bundled Maven $MAVEN_VERSION ($(du -sh "$TARGET" | cut -f1)) in extension/maven"
