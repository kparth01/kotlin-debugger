#!/bin/bash
set -euo pipefail

# Maven-based build script for Kotlin Debug Plugin
# Builds adapter (Kotlin), bundles into extension (TypeScript), creates self-contained VSIX

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "Kotlin Debug Plugin - Complete Build"
echo "=========================================="
echo ""

# Set JAVA_HOME if not already set (prefer 17 for wider compatibility)
if [ -z "${JAVA_HOME:-}" ]; then
    if [ -d "/opt/homebrew/opt/openjdk@17" ]; then
        export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
    elif [ -d "/opt/homebrew/opt/openjdk@21" ]; then
        export JAVA_HOME="/opt/homebrew/opt/openjdk@21"
    fi
fi

export PATH="${JAVA_HOME}/bin:${PATH}"

# Check prerequisites
echo "[1/5] Checking prerequisites..."

if ! command -v java &> /dev/null; then
    echo "❌ Java not found. Install with: brew install openjdk@21"
    exit 1
fi
echo "  ✓ $(java -version 2>&1 | head -1)"

if ! command -v mvn &> /dev/null; then
    echo "❌ Maven not found. Install with: brew install maven"
    exit 1
fi
echo "  ✓ Maven: $(mvn -version 2>&1 | head -1)"

if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Install with: brew install node"
    exit 1
fi
echo "  ✓ npm: $(npm --version)"

# Build Kotlin Debug Adapter (Maven)
echo ""
echo "[2/5] Building Kotlin Debug Adapter (Maven)..."
cd "$PROJECT_ROOT/src/kotlin-debug-adapter"

mvn clean package -DskipTests -q

# Find the built JAR (Maven creates kotlin-debug-adapter-1.0.0.jar)
ADAPTER_JAR=$(find target -name "kotlin-debug-adapter-*.jar" -type f | head -1)
if [ -z "$ADAPTER_JAR" ]; then
    echo "❌ Adapter build failed - JAR not created"
    exit 1
fi
echo "  ✓ Adapter built: $ADAPTER_JAR"

# Create shell wrapper script
ADAPTER_BIN="target/kotlin-debug-adapter"
cat > "$ADAPTER_BIN" << 'SCRIPT'
#!/bin/bash
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
JAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${JAVA_HOME}/bin/java" -cp "${JAR_DIR}/*" org.javacs.ktda.KDAMainKt "$@"
SCRIPT
chmod +x "$ADAPTER_BIN"
echo "  ✓ Wrapper script created"

# Build VSCode Extension (npm)
echo ""
echo "[3/5] Building VSCode Extension (npm)..."
cd "$PROJECT_ROOT/src/vscode-kotlin"

npm install --silent --no-save 2>/dev/null || npm install --silent
npm run vscode:prepublish --silent

echo "  ✓ Extension compiled"

# Bundle adapter into extension
echo ""
echo "[4/5] Bundling adapter into extension..."

mkdir -p lib/kotlin-debug-adapter/{bin,lib}

# Copy executable wrapper
cp "$PROJECT_ROOT/src/kotlin-debug-adapter/$ADAPTER_BIN" lib/kotlin-debug-adapter/bin/kotlin-debug-adapter
chmod +x lib/kotlin-debug-adapter/bin/kotlin-debug-adapter

# Copy main JAR (use the versioned JAR from Maven)
cp "$PROJECT_ROOT/src/kotlin-debug-adapter/$ADAPTER_JAR" lib/kotlin-debug-adapter/lib/

# Copy all dependencies from Maven's dependency directory
if [ -d "$PROJECT_ROOT/src/kotlin-debug-adapter/target/dependency" ]; then
    cp "$PROJECT_ROOT/src/kotlin-debug-adapter/target/dependency"/*.jar lib/kotlin-debug-adapter/lib/ 2>/dev/null || true
fi

JAR_COUNT=$(ls lib/kotlin-debug-adapter/lib/*.jar 2>/dev/null | wc -l)
echo "  ✓ Bundled: adapter + $JAR_COUNT JARs"

# Package VSIX
echo ""
echo "[5/5] Packaging VSIX..."

npm install -g @vscode/vsce 2>/dev/null || true
npx --yes @vscode/vsce package --allow-star-activation

VSIX=$(find . -maxdepth 1 -name "*.vsix" -type f | head -1)

if [ -z "$VSIX" ]; then
    echo "❌ Failed to create VSIX"
    exit 1
fi

# Copy VSIX to project root
cp "$VSIX" "$PROJECT_ROOT/"
VSIX_PATH="$PROJECT_ROOT/$VSIX"
VSIX_SIZE=$(du -h "$VSIX_PATH" | cut -f1)

echo ""
echo "=========================================="
echo "✅ Build Complete!"
echo "=========================================="
echo ""
echo "📦 Extension Package:"
echo "   File: $VSIX_PATH"
echo "   Size: $VSIX_SIZE"
echo ""
echo "📋 Contents:"
echo "   ✓ VSCode Extension (TypeScript → JavaScript)"
echo "   ✓ Kotlin Debug Adapter (Maven built)"
echo "   ✓ All dependencies"
echo "   ✓ Self-contained (offline-ready)"
echo ""
echo "🚀 Install in VSCode:"
echo "   1. Extensions panel (Cmd+Shift+X)"
echo "   2. Click ... → Install from VSIX"
echo "   3. Select: $VSIX_PATH"
echo "   4. Reload VSCode"
echo ""
echo "💡 Ready to distribute!"
echo ""
