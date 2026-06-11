# Kotlin Debug Plugin for VSCode

A patched Kotlin debug adapter for VSCode that fixes breakpoint handling and inline function line mapping in Kotlin/JVM projects.

## Features

✅ **Working Breakpoints** — Set and pause at breakpoints in Kotlin code  
✅ **Variable Inspection** — Inspect local variables, objects, and stack frames  
✅ **Step Debugging** — Step over, step into, step out of functions  
✅ **Call Stack Navigation** — View and navigate the call stack  
✅ **SMAP Stratum Awareness** — Improved line mapping for inline functions (partial)

## What's Fixed

| Issue | Status | Notes |
|-------|--------|-------|
| Breakpoints not firing | ✅ Fixed | Exception handling + fallback in `locationsOfLine` |
| Line mapping for inline functions | ⚠️ Partial | Breakpoints work; line numbers may show inside function body |
| Coroutine debugging | ❌ Not yet | Use IntelliJ for suspend function debugging |

## Requirements

- **VSCode** 1.52.0+
- **Java** 17+ (JDK 17 or JDK 21)
- **Kotlin** project with Maven
- **Maven** 3.9+ for building projects
- **Node.js** 16+ for extension build

## Installation

### From VSIX

1. Download the latest `kotlin-debug-*.vsix` from [Releases](../../releases)
2. In VSCode: **Extensions** → **`...`** → **Install from VSIX...**
3. Select the downloaded `.vsix` file
4. Reload VSCode

### From Source

```bash
git clone <this-repo>
cd kotlin-debug-plugin
./scripts/build.sh
./scripts/package.sh
# Output: kotlin-debug-*.vsix
```

## Usage

### Launch Configuration

Add to `.vscode/launch.json`:

```json
{
  "type": "kotlin",
  "request": "launch",
  "name": "Debug Kotlin App",
  "projectRoot": "${workspaceFolder}",
  "mainClass": "com.example.AppKt",
  "preLaunchTask": "maven: compile"
}
```

### Set Breakpoints

1. Open a `.kt` file
2. Click in the gutter (left margin) on any line
3. Press **F5** or **Run → Start Debugging**

### Debug Controls

- **F5** — Continue
- **F10** — Step over
- **F11** — Step into
- **Shift+F11** — Step out
- **Shift+F5** — Stop

## Architecture

```
kotlin-debug-plugin/
├── src/
│   ├── vscode-kotlin/          # VSCode extension (UI)
│   │   ├── src/                # TypeScript extension code
│   │   ├── package.json        # Extension manifest
│   │   └── ...
│   │
│   └── kotlin-debug-adapter/   # Debug adapter (JVM backend)
│       ├── adapter/            # Main adapter implementation
│       ├── build.gradle.kts    # Gradle build
│       └── ...
│
├── scripts/
│   ├── build.sh               # Build both components
│   └── package.sh             # Package VSIX
│
└── docs/
    ├── ARCHITECTURE.md        # Technical details
    └── KNOWN_ISSUES.md        # Limitations and workarounds
```

### How It Works

1. **VSCode Extension** (TypeScript) registers the Kotlin debug type
2. **User presses F5** → Extension launches the debug adapter
3. **Debug Adapter** (Kotlin/JVM) connects to running JVM via JDWP
4. **Breakpoints, stepping, variables** flow through DAP (Debug Adapter Protocol)
5. **Line mapping** uses Kotlin's SMAP strata when available

## Known Limitations

### Inline Functions

When debugging code inside an inline lambda:
- ✅ Breakpoints work correctly
- ⚠️ Line numbers may show inside the inline function body instead of the call site
- **Workaround**: Use IntelliJ IDEA for this specific case, or step carefully

### Coroutines

Suspend functions and `async {}`/`flow {}` have incomplete support:
- ✅ Breakpoints work
- ❌ Async call stacks not reconstructed
- ❌ No "Coroutines" debug panel

**Workaround**: For heavy coroutine debugging, use **IntelliJ IDEA Community** (free) or **Ultimate** — it has a dedicated Coroutines debugger.

### Classpath Resolution

For Maven projects, ensure:
- Run `mvn compile` before debugging, OR
- Use `preLaunchTask: "maven: compile"` in launch.json

For Gradle projects, run `./gradlew build` first.

## Troubleshooting

### "Failed to attach to JVM"

**Cause**: Port mismatch or JVM not listening  
**Fix**: 
- Ensure no other process is using the debug port (default: 5005)
- Check firewall settings
- Verify `JAVA_HOME` is set correctly

### Breakpoints not firing

**Cause**: Class not yet loaded, or classpath mismatch  
**Fix**:
- Rebuild the project (`mvn clean compile`)
- Reload VSCode window (Cmd+Shift+P → "Reload Window")
- Check that breakpoint is in compiled source file

### "Unknown Source" in call stack

**Cause**: Source file not found by debugger  
**Fix**:
- Ensure `.vscode/launch.json` has correct `projectRoot`
- Check that source files are in `src/main/kotlin/` or `src/main/java/`

## Building from Source

### Prerequisites

- JDK 11+
- Gradle 8.3+
- Node.js 16+ (for VSCode extension)
- Maven (for example projects)

### Build Steps

```bash
# Build the debug adapter (Kotlin/JVM)
cd src/kotlin-debug-adapter
./gradlew :adapter:installDist

# Build the VSCode extension (TypeScript)
cd ../vscode-kotlin
npm install
npm run vscode:prepublish

# Package into VSIX
npm run package-extension

# Output: kotlin-0.2.37.vsix
```

Or use the provided scripts:

```bash
./scripts/build.sh    # Build everything
./scripts/package.sh  # Create VSIX
```

## Contributing

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for guidelines.

## License

This project combines:
- **fwcd/vscode-kotlin** (Apache 2.0)
- **fwcd/kotlin-debug-adapter** (Apache 2.0)
- **Patches for stratum support** (Apache 2.0)

See [LICENSE](LICENSE) for details.

## Support

- **Issues**: Report bugs at [GitHub Issues](../../issues)
- **Discussion**: [Discussions](../../discussions)
- **IntelliJ Alternative**: For production coroutine debugging, use [IntelliJ IDEA](https://www.jetbrains.com/idea/)

## Acknowledgments

Built on top of:
- [fwcd/vscode-kotlin](https://github.com/fwcd/vscode-kotlin) — VSCode Kotlin extension
- [fwcd/kotlin-debug-adapter](https://github.com/fwcd/kotlin-debug-adapter) — Debug adapter
- [Eclipse LSP4J](https://projects.eclipse.org/projects/technology.lsp4j) — Debug Adapter Protocol

---

**Status**: Production-ready for regular debugging. Known limitations in inline function line mapping and coroutine debugging.
