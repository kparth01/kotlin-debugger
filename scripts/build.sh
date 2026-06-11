#!/bin/bash
set -euo pipefail

# Build script for Kotlin Debug Plugin
# Builds both the debug adapter (Kotlin/JVM) and VSCode extension (TypeScript)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "Kotlin Debug Plugin - Build Script"
echo "=========================================="
echo ""

# Check prerequisites
echo "[1/4] Checking prerequisites..."
if ! command -v java &> /dev/null; then
    echo "❌ Java not found. Install JDK 11+ and set JAVA_HOME."
    exit 1
fi
JAVA_VERSION=$(java -version 2>&1 | head -1)
echo "  ✓ Java: $JAVA_VERSION"

if ! command -v gradle &> /dev/null && [ ! -f "$PROJECT_ROOT/src/kotlin-debug-adapter/gradlew" ]; then
    echo "❌ Gradle not found. Install Gradle 8.3+ or ensure gradlew exists."
    exit 1
fi
echo "  ✓ Gradle found"

if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Install Node.js 16+."
    exit 1
fi
NPM_VERSION=$(npm --version)
echo "  ✓ npm: $NPM_VERSION"

# Build adapter
echo ""
echo "[2/4] Building Kotlin Debug Adapter..."
cd "$PROJECT_ROOT/src/kotlin-debug-adapter"

# Use gradle wrapper if available, else gradle command
if [ -f "gradlew" ]; then
    ./gradlew :adapter:installDist --console=plain -x test
else
    gradle :adapter:installDist --console=plain -x test
fi

ADAPTER_PATH="adapter/build/install/adapter/bin/kotlin-debug-adapter"
if [ -f "$ADAPTER_PATH" ]; then
    echo "  ✓ Adapter built: $ADAPTER_PATH"
else
    echo "❌ Adapter build failed"
    exit 1
fi

# Build extension
echo ""
echo "[3/4] Building VSCode Extension..."
cd "$PROJECT_ROOT/src/vscode-kotlin"

npm install
npm run vscode:prepublish

echo "  ✓ Extension compiled"

# Summary
echo ""
echo "=========================================="
echo "✅ Build successful!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Run: $SCRIPT_DIR/package.sh"
echo "  2. Install the generated .vsix in VSCode"
echo ""
