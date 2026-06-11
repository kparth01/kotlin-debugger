# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      VSCode (User)                          │
├─────────────────────────────────────────────────────────────┤
│  vscode-kotlin Extension (TypeScript)                       │
│  • Language server integration                              │
│  • Syntax highlighting                                      │
│  • Debug type registration                                  │
│  • Launch/attach handling                                   │
├─────────────────────┬───────────────────────────────────────┤
│                     │ DAP (stdin/stdout)                    │
│  ┌──────────────────▼─────────────────────────────┐         │
│  │ kotlin-debug-adapter (Kotlin/JVM)              │         │
│  │ • Implements Debug Adapter Protocol            │         │
│  │ • Manages JDI session lifecycle                │         │
│  │ • Converts DAP ↔ JDI calls                     │         │
│  │ • Handles breakpoint setting/SMAP mapping     │         │
│  └──────────────────┬─────────────────────────────┘         │
│                     │ JDWP (socket)                         │
│                     │                                       │
└─────────────────────┼───────────────────────────────────────┘
                      │
           ┌──────────▼──────────┐
           │  Running JVM        │
           │  (Your App)         │
           │                     │
           │  MainKt.class ──────┼── Bytecode + Line Numbers
           │  AppKt.class        │   (SMAP strata)
           │  ...                │
           └─────────────────────┘
```

## Components

### 1. VSCode Extension (`src/vscode-kotlin/`)

**Language**: TypeScript  
**Responsibility**: UI layer, user interaction

- **Activation**: When a `.kt` file is opened
- **Registration**: Registers `kotlin` debug type in DAP
- **Launch/Attach**: Spawns the debug adapter process
- **Configuration**: Reads `launch.json` and passes config to adapter
- **Language Server**: Syntax highlighting, completions (separate concern)

**Key Files**:
- `src/extension.ts` — Main extension entry point
- `src/debugSetup.ts` — Debug adapter lifecycle
- `package.json` — Extension manifest

### 2. Debug Adapter (`src/kotlin-debug-adapter/`)

**Language**: Kotlin/JVM  
**Responsibility**: Backend debugger, JDI orchestration

**Subsystems**:

#### a. DAP Server (`KotlinDebugAdapter.kt`)
- Implements the Debug Adapter Protocol spec
- Receives requests from VSCode (initialize, setBreakpoints, etc.)
- Sends responses and events back

#### b. JDI Session Manager (`JDIDebuggee.kt`)
- Manages Java Debug Interface (JDWP) connection to running JVM
- **Breakpoint setting** (`setBreakpointAtType`) — **KEY FIX LOCATION**
- **Stack frame mapping** (`positionOf`) — Maps JVM locations to source
- **Line number resolution** — Uses Kotlin SMAP strata

#### c. Event Bus (`VMEventBus.kt`)
- Listens to JVM events (breakpoint hits, thread lifecycle, etc.)
- Converts to DAP events (stopped, thread, output, etc.)

#### d. Classpath Resolver (`PathUtils.kt`)
- Resolves file paths to JVM class names
- Example: `src/main/kotlin/App.kt` → `AppKt` class

**Key Files**:
- `adapter/src/main/kotlin/org/javacs/ktda/jdi/JDIDebuggee.kt` — **PATCHED FOR SMAP STRATA**
- `adapter/src/main/kotlin/org/javacs/ktda/adapter/KotlinDebugAdapter.kt` — DAP handler
- `build.gradle.kts` — Build configuration

### 3. Line Mapping (The Patch)

**File**: `src/kotlin-debug-adapter/adapter/src/main/kotlin/org/javacs/ktda/jdi/JDIDebuggee.kt`

**Problem**: Without the patch, breakpoints use only the JVM's default `LineNumberTable`, which for inline functions points inside the inlined body, not the call site.

**Solution**: 

1. **Read available strata** from class file's `SourceDebugExtension` (SMAP)
   ```kotlin
   private fun ReferenceType.kotlinStratum(): String?
   ```

2. **Prefer `KotlinDebug` stratum** when setting breakpoints
   - `KotlinDebug` remaps inlined bytecode back to the *call site*
   ```kotlin
   refType.locationsOfLine(stratum, sourceName, lineNumber)
   ```

3. **Fallback to default stratum** if 3-arg version fails
   ```kotlin
   refType.locationsOfLine(lineNumber)
   ```

**Result**: 
- ✅ Breakpoints work (fixed by fallback)
- ⚠️ Inline line mapping partially active (3-arg method returns empty in some cases)

## Data Flow: Setting a Breakpoint

```
User clicks gutter on line 17
           ↓
VSCode sends: setBreakpoints(source="Main.kt", breakpoints=[{line: 17}])
           ↓
KotlinDebugAdapter.setBreakpoints() receives request
           ↓
Resolves "Main.kt" → "MainKt" class
           ↓
Calls: setBreakpointAtType(refType=MainKt, sourceName="Main.kt", lineNumber=17)
           ↓
Gets strata: kotlinStratum() → ["KotlinDebug", "Kotlin"]
           ↓
Tries: refType.locationsOfLine("KotlinDebug", "Main.kt", 17)
           ↓
IF succeeds → Creates breakpoint on returned location
IF fails    → Falls back to: refType.locationsOfLine(17)
           ↓
JDI creates BreakpointRequest on the location
           ↓
VSCode receives: BreakpointsResponse(verified=true)
           ↓
Red dot appears in editor
```

## Data Flow: Hitting a Breakpoint

```
JVM executes bytecode at breakpoint location
           ↓
JDI sends: BreakpointEvent
           ↓
VMEventBus receives and converts to DAP: StoppedEvent(reason="breakpoint")
           ↓
KotlinDebugAdapter sends event to VSCode
           ↓
VSCode shows yellow highlight, opens call stack panel
           ↓
User can:
  • Inspect variables: VSCode sends scopes(), variables() requests
  • Step: VSCode sends next(), stepIn(), stepOut() requests
  • Continue: VSCode sends continue() request
```

## SMAP (Source Map) Explanation

**SMAP** (Source Map) is metadata embedded in `.class` files that maps bytecode locations to source lines.

**Format**: 
```
SMAP
Main.kt
Kotlin
*S Kotlin
*F
+ 1 Main.kt MainKt
+ 2 Measured.kt MeasuredKt
*L
1#1,5:1      (Main.kt lines 1-5 → bytecode 1-5)
2#2,3:6      (Measured.kt lines 2-4 → bytecode 6-8)
*S KotlinDebug
*F
+ 1 Main.kt MainKt
*L
2#1:6        (bytecode 6 in "KotlinDebug" stratum → Main.kt line 2)
*E
```

**Key Strata**:
- `Kotlin` (default) — Maps bytecode to actual source location (inside inline body)
- `KotlinDebug` — Maps inlined bytecode back to call site (what we want)

**Our fix**: Try `KotlinDebug` first, fallback to `Kotlin` or JVM default.

## Known Issues in Current Implementation

### Three-Argument `locationsOfLine` Not Reliable

The call:
```kotlin
refType.locationsOfLine(stratum, sourceName, lineNumber)
```

Sometimes returns empty list, even for valid inputs. Possible causes:
- `sourceName` format mismatch (expects full path, we pass filename)
- Method not fully implemented in JDI version used
- SMAP stratum not applied correctly in all cases

**Mitigation**: Wrapped in try-catch with fallback to one-argument version. Breakpoints work, but full stratum awareness is limited.

### Coroutines Not Supported

Suspend functions compile to state machines. Proper debugging requires:
1. Reconstructing the continuation chain
2. Showing async call stacks
3. Mapping resume points back to source

This is **not implemented** and requires significant work (would be Milestone 3).

## Testing

### Unit Tests
```bash
cd src/kotlin-debug-adapter
./gradlew :adapter:test
```

### Manual Testing
1. Create a simple Kotlin app
2. Set breakpoint in VSCode
3. Run with debugger (F5)
4. Verify:
   - Breakpoint pauses execution
   - Variables visible
   - Stepping works

### Integration Testing
See [TESTING.md](TESTING.md) for detailed test cases.

## Extension Points

### Adding Language Support
Modify `src/vscode-kotlin/src/extension.ts` to register additional debug types.

### Custom Breakpoint Conditions
Modify `src/kotlin-debug-adapter/.../setBreakpoints()` to handle conditional breakpoints.

### Coroutine Debugging
Would require:
1. Parsing coroutine metadata at runtime
2. Reconstructing async call stacks
3. Adding coroutine-aware stepping

See **[Milestone 3](../README.md)** for scope.
