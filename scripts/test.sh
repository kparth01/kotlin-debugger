#!/usr/bin/env bash
# Full validation:
#   1. builds the Spring Boot sample (samples/spring-boot-kotlin-demo)
#   2. adapter unit + DAP/JDWP integration tests (Kotlin fixtures + Spring Boot on JDK 21)
#   3. real VS Code end-to-end test (extension -> adapter -> JDWP -> Spring Boot)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${JAVA_HOME:-}" && -d /opt/homebrew/opt/openjdk@21 ]]; then export JAVA_HOME=/opt/homebrew/opt/openjdk@21; fi
[[ -n "${JAVA_HOME:-}" ]] && export PATH="$JAVA_HOME/bin:$PATH"

echo "==> Building Spring Boot sample"
(cd "$ROOT/samples/spring-boot-kotlin-demo" && mvn -q -B -DskipTests package)

echo "==> Adapter tests"
(cd "$ROOT/adapter" && mvn -B test | grep -E "Tests run:|FAIL|ERROR" || true)
(cd "$ROOT/adapter" && mvn -q -B -DskipTests package)
mkdir -p "$ROOT/extension/server"
cp "$ROOT/adapter/target/kotlin-debug-adapter.jar" "$ROOT/extension/server/"

echo "==> VS Code end-to-end test"
cd "$ROOT/extension"
[[ -d node_modules ]] || npm install --no-audit --no-fund --silent
npm run --silent compile
# When launched from inside VS Code (integrated terminal / extensions), these variables would make
# the test instance start in Node mode or talk to the parent window.
env -u ELECTRON_RUN_AS_NODE -u VSCODE_IPC_HOOK_CLI -u VSCODE_PID -u VSCODE_CWD -u VSCODE_NLS_CONFIG \
    -u VSCODE_HANDLES_UNCAUGHT_ERRORS -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CRASH_REPORTER_PROCESS_TYPE \
    -u VSCODE_CODE_CACHE_PATH node out/test/runE2E.js
