#!/bin/bash
set -euo pipefail

# Package script - Creates VSIX extension from built sources

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "Kotlin Debug Plugin - Package Script"
echo "=========================================="
echo ""

# Check if vsce is installed
echo "[1/2] Checking prerequisites..."
if ! command -v vsce &> /dev/null; then
    echo "  Installing vsce (VSCode extension packaging tool)..."
    npm install -g @vscode/vsce
fi
echo "  ✓ vsce ready"

# Package extension
echo ""
echo "[2/2] Packaging VSCode extension..."
cd "$PROJECT_ROOT/src/vscode-kotlin"

# Create VSIX
npx --yes @vscode/vsce package --allow-star-activation

# Find the generated VSIX
VSIX=$(find . -maxdepth 1 -name "*.vsix" -type f | head -1)

if [ -n "$VSIX" ]; then
    # Copy to project root for easy access
    cp "$VSIX" "$PROJECT_ROOT/"
    echo ""
    echo "=========================================="
    echo "✅ Package successful!"
    echo "=========================================="
    echo ""
    echo "Extension file: $PROJECT_ROOT/$VSIX"
    echo ""
    echo "Install in VSCode:"
    echo "  1. Open Extensions (Cmd+Shift+X)"
    echo "  2. Click '...' menu → Install from VSIX"
    echo "  3. Select: $PROJECT_ROOT/$VSIX"
    echo ""
else
    echo "❌ Failed to create VSIX"
    exit 1
fi
