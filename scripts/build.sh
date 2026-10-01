#!/usr/bin/env bash
# Builds the Kotlin debug adapter (fat jar) and the VS Code extension, and packages a
# self-contained VSIX into dist/.
#
#   scripts/build.sh               # build + unit/integration tests of the adapter
#   scripts/build.sh --skip-tests  # build only
#
# Requires: JDK 17+ (JAVA_HOME or java on PATH), Maven 3.9+, Node.js 18+.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_TESTS=false
[[ "${1:-}" == "--skip-tests" ]] && SKIP_TESTS=true

if [[ -z "${JAVA_HOME:-}" && -d /opt/homebrew/opt/openjdk@21 ]]; then export JAVA_HOME=/opt/homebrew/opt/openjdk@21; fi
[[ -n "${JAVA_HOME:-}" ]] && export PATH="$JAVA_HOME/bin:$PATH"

echo "==> Java:  $(java -version 2>&1 | head -1)"
echo "==> Maven: $(mvn -v 2>/dev/null | head -1)"
echo "==> Node:  $(node -v)"

echo "==> [1/3] Debug adapter (Kotlin, JDI/JDWP, DAP)"
cd "$ROOT/adapter"
if $SKIP_TESTS; then
  mvn -q -B -DskipTests package
else
  # The Spring Boot validation tests run when the sample is built.
  (cd "$ROOT/samples/spring-boot-kotlin-demo" && mvn -q -B -DskipTests package)
  mvn -q -B package
fi
mkdir -p "$ROOT/extension/server"
cp target/kotlin-debug-adapter.jar "$ROOT/extension/server/kotlin-debug-adapter.jar"
echo "    adapter: $(java -jar "$ROOT/extension/server/kotlin-debug-adapter.jar" --version)"

echo "==> [2/3] VS Code extension (TypeScript)"
cd "$ROOT/extension"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --silent; else npm install --no-audit --no-fund --silent; fi
npm run --silent compile

echo "==> [3/3] Packaging VSIX"
mkdir -p "$ROOT/dist"
npx --no-install vsce package --no-dependencies --allow-missing-repository --skip-license -o "$ROOT/dist/" >/dev/null
VSIX="$(ls -t "$ROOT"/dist/*.vsix | head -1)"
echo ""
echo "Built $VSIX ($(du -h "$VSIX" | cut -f1))"
echo "Install:  code --install-extension \"$VSIX\""
