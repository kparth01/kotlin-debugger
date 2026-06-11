# Self-Contained VSIX Build Guide

This guide explains how to build a **complete, self-contained VSIX** that includes the Kotlin debug adapter JAR and all dependencies — **no downloads needed**.

## What's Self-Contained?

A self-contained VSIX includes:

```
kotlin-debug-0.2.37.vsix (5-7 MB)
│
├── Extension Code (TypeScript compiled to JavaScript)
│   └── dist/extension.js
│
├── Debug Adapter (Bundled)
│   ├── lib/kotlin-debug-adapter/
│   │   ├── bin/
│   │   │   ├── kotlin-debug-adapter (Mac/Linux executable)
│   │   │   └── kotlin-debug-adapter.bat (Windows executable)
│   │   │
│   │   └── lib/
│   │       ├── adapter.jar (Kotlin compiled to bytecode)
│   │       ├── kotlin-stdlib-2.1.0.jar
│   │       ├── kotlin-reflect-2.1.0.jar
│   │       └── [all other dependencies]
│
└── Configuration
    └── package.json (manifest)
```

**Benefits:**
- ✅ **One file to distribute** — No downloads, no setup
- ✅ **Offline ready** — Works without internet
- ✅ **Version locked** — Adapter version matches extension version
- ✅ **Enterprise friendly** — Easy to deploy internally
- ✅ **Fast first use** — No wait for downloads

---

## Quick Build (One Command)

```bash
cd /Users/parth.kansara/Projects/AIProjects/KotlinCompiler/kotlin-debug-plugin

# Make script executable
chmod +x scripts/build-complete.sh

# Install JDK 17 (if not already installed)
brew install openjdk@17

# Build everything and create self-contained VSIX
./scripts/build-complete.sh
```

**Output:**
```
✅ Build Complete!

📦 Extension Package:
   File: /path/to/kotlin-debug-0.2.37.vsix
   Size: 5.2 MB

📋 What's Included:
   ✓ VSCode Extension (TypeScript compiled to JS)
   ✓ Kotlin Debug Adapter (compiled to JAR)
   ✓ All dependencies (kotlin-stdlib, etc.)
   ✓ Native binaries (Java 11+)

🚀 Install in VSCode:
   1. Extensions → ... → Install from VSIX
   2. Select: /path/to/kotlin-debug-0.2.37.vsix
   3. Reload VSCode
```

---

## Manual Step-by-Step

If you want more control, follow these steps:

### Step 1: Build the Adapter

```bash
cd kotlin-debug-plugin/src/kotlin-debug-adapter

export JAVA_HOME="/opt/homebrew/opt/openjdk@21"
./gradlew :adapter:installDist --console=plain -x test
```

**Expected:**
```
BUILD SUCCESSFUL
Adapter: adapter/build/install/adapter/
```

### Step 2: Bundle into Extension

```bash
# Create lib directory in extension
mkdir -p vscode-kotlin/lib/kotlin-debug-adapter/bin
mkdir -p vscode-kotlin/lib/kotlin-debug-adapter/lib

# Copy adapter binary
cp kotlin-debug-adapter/adapter/build/install/adapter/bin/kotlin-debug-adapter \
   vscode-kotlin/lib/kotlin-debug-adapter/bin/

# Copy all dependencies
cp -r kotlin-debug-adapter/adapter/build/install/adapter/lib/* \
      vscode-kotlin/lib/kotlin-debug-adapter/lib/
```

**Result:**
```
vscode-kotlin/
└── lib/kotlin-debug-adapter/
    ├── bin/
    │   └── kotlin-debug-adapter ✓
    └── lib/
        ├── adapter.jar ✓
        ├── kotlin-stdlib-2.1.0.jar ✓
        └── [15+ other JARs] ✓
```

### Step 3: Build Extension

```bash
cd vscode-kotlin

npm install
npm run vscode:prepublish
```

**Expected:**
```
✓ Webpack compiled successfully
```

### Step 4: Package VSIX

```bash
npm install -g @vscode/vsce
npx @vscode/vsce package --allow-star-activation
```

**Result:**
```
DONE  Packaged: kotlin-0.2.37.vsix (5 files, 5.2 MB)
```

---

## How It Works at Runtime

When a user installs and uses the VSIX:

```
User presses F5 (Debug)
    ↓
VSCode loads extension.js (from VSIX)
    ↓
Extension checks for adapter:
    ├─ Bundled? (in lib/kotlin-debug-adapter/)
    │  ├─ YES → Use immediately ✓
    │  └─ NO  → Continue
    │
    └─ Downloaded? (in ~/.vscode/)
       ├─ YES → Use
       └─ NO  → Try download (may fail offline)
    ↓
Launch: /path/to/lib/kotlin-debug-adapter/bin/kotlin-debug-adapter
    ↓
Debug session starts (no downloads needed!)
```

The code change in `debugSetup.ts`:
```typescript
// Try bundled first
const bundledAdapterPath = path.join(context.extensionPath, "lib", "kotlin-debug-adapter", "bin", ...);
if (fs.existsSync(bundledAdapterPath)) {
    startScriptPath = bundledAdapterPath;  // Use bundled
} else {
    // Fallback to download
}
```

---

## Verifying the Build

After building, check that the VSIX contains the adapter:

```bash
# Unzip and inspect (VSIX is just a ZIP file)
cd kotlin-debug-0.2.37.vsix  # or wherever it is
unzip -l kotlin-debug-0.2.37.vsix | grep -E "(adapter|lib)"

# You should see:
#   lib/kotlin-debug-adapter/bin/kotlin-debug-adapter
#   lib/kotlin-debug-adapter/lib/adapter.jar
#   lib/kotlin-debug-adapter/lib/kotlin-stdlib-2.1.0.jar
#   lib/kotlin-debug-adapter/lib/[...other JARs...]
```

---

## Distribution

### For Internal Company Use

```bash
# Build once
./scripts/build-complete.sh

# Upload to internal server/artifactory
# Users download: kotlin-debug-0.2.37.vsix
# Install: Extensions → Install from VSIX → select file
# Done!
```

### For Open Source / Marketplace

```bash
# 1. Build
./scripts/build-complete.sh

# 2. Create GitHub Release
git tag v1.0.0
git push origin v1.0.0

# 3. Upload VSIX to release (GitHub Actions can do this automatically)
# 4. Users can install from VSCode Marketplace (if published)
```

---

## Size Optimization

Current size: **~5-7 MB**

If size is a concern:

| Optimization | Savings | Trade-off |
|--------------|---------|-----------|
| Remove test dependencies | 500 KB | Minimal |
| Minify JARs | 1-2 MB | None (internal format) |
| Ship only JDK 17 | 200 KB | Lose support for JDK 11/8 |
| Compress better | 1-2 MB | Slower extraction |

For most cases, **5-7 MB is acceptable** and the current size is fine.

---

## Troubleshooting

### VSIX builds but adapter not found

**Symptom**: VSIX created, but when installed, says "adapter not found"

**Fix**:
```bash
# Make sure bundling succeeded
unzip -l kotlin-debug-0.2.37.vsix | grep adapter

# Should show files. If not, re-run build:
./scripts/build-complete.sh
```

### "adapter.jar not found" on first use

**Symptom**: First debug session fails to find adapter

**Fix**:
```bash
# This shouldn't happen with self-contained, but if it does:
# Extension falls back to download. Check network/firewall.
# Or manually re-run build.
```

### VSIX won't install in VSCode

**Symptom**: "Invalid extension" error

**Fix**:
```bash
# Re-run build:
./scripts/build-complete.sh

# If still fails, check for syntax errors:
cd src/vscode-kotlin
npm run compile
npm run vscode:prepublish
```

---

## Next Steps

1. ✅ Build the VSIX: `./scripts/build-complete.sh`
2. 📦 Distribute the `.vsix` file
3. 👥 Users install in VSCode (no downloads, offline-ready)
4. 🚀 Debug Kotlin code

---

## For Developers: Modifying the Build

To customize:

1. **Change adapter version**:
   ```bash
   cd src/kotlin-debug-adapter
   # Edit gradle.properties:
   # kotlinVersion=2.1.0  ← Change this
   # Then rebuild
   ```

2. **Add more dependencies**:
   - Edit `src/kotlin-debug-adapter/adapter/build.gradle.kts`
   - Run build-complete.sh again

3. **Customize extension**:
   - Edit `src/vscode-kotlin/src/*.ts`
   - npm run vscode:prepublish
   - Run build-complete.sh

---

**Status**: ✅ Ready for production deployment
