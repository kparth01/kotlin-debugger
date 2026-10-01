# Kotlin Debugger for VS Code (JVM / Spring Boot)

Debug Kotlin code running on any JVM (JDK 21 tested) from VS Code. Attach to a Spring Boot (or any)
JVM over JDWP, set breakpoints in `.kt` files, and step, inspect and evaluate in Kotlin terms.

```
VS Code ──DAP──▶ kotlin-debug-adapter.jar ──JDI/JDWP──▶ your JVM (-agentlib:jdwp=…)
          (stdio)   (Kotlin, bundled in the VSIX)        local, Docker, Kubernetes, remote host
```

## Contents

- [Features](#features)
- [Build and install](#build-and-install)
- [Start your JVM with a debug port](#start-your-jvm-with-a-debug-port)
- [VS Code configuration](#vs-code-configuration)
- [Attach and debug](#attach-and-debug)
- [Kotlin compiler settings](#kotlin-compiler-settings)
- [Configuration reference](#configuration-reference)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Development and tests](#development-and-tests)

## Features

| Area | Support |
|------|---------|
| Attach to a running JVM (JDWP socket, local or remote) | ✅ retries until the port opens; actionable errors |
| Launch a main class (classpath from Maven/Gradle or explicit) | ✅ |
| Line breakpoints in `.kt` (and `.java`) | ✅ resolved by source file + package, not by class-name guessing: top-level functions, classes, companions, objects, lambdas (indy and class-based), anonymous objects, local functions, `init` blocks, generic and sealed classes |
| Breakpoints inside **inline functions** (also from other files/packages) | ✅ bound in every inlined call site via Kotlin's SMAP |
| Breakpoints on classes loaded later / reloaded (DevTools restart) | ✅ bound on class load |
| Conditional breakpoints, hit counts (`5`, `>5`, `%3`), logpoints (`{expr}`) | ✅ |
| Function breakpoints (`OrderService.placeOrder`) | ✅ |
| Exception breakpoints | ✅ *Uncaught*, *Caught (application code)*, *All caught*, and an optional class filter |
| Continue / pause / step over / into / out | ✅ Kotlin-aware (see below) |
| Call stack | ✅ Kotlin names, inline-function frames, Spring proxy frames de-emphasized, coroutine async stack |
| Threads | ✅ including JDK 21 **virtual threads** when stopped |
| Variables | ✅ Kotlin names, captured lambda variables, `this@receiver`, inline-function locals in their own frame, data class `toString()`, collections and maps as elements, `[static]` members |
| Evaluate / watch / hover / Debug Console | ✅ Kotlin expression subset (below) |
| Set variable | ✅ locals, fields, array elements |
| `suspend` functions / coroutines | ✅ breakpoints, variables, async callers, **step over a suspension point** (continues in the same coroutine, even on another thread) |

**Kotlin-aware stepping**
- *Step Over* a call to an inline function does not enter its body. Inline lambda bodies on
  following lines still stop.
- *Step Into* skips JDK, Kotlin stdlib, kotlinx, Spring, CGLIB proxies, AOP plumbing and other
  library code. Unknown libraries without sources are learned and skipped automatically. Your own
  aspects and interceptors still stop.
- Bridges, `$default` trampolines, `access$` accessors and lambda proxy classes are stepped through.
- In `suspend` functions the state-machine plumbing (dispatch, `return COROUTINE_SUSPENDED`) is
  never shown as a step location.

**Expression evaluation** works on the live JVM through JDI. No code is compiled or injected. It supports:
- Locals, `this`, `this@label`, captured variables, and implicit receivers of extension functions.
- Properties through fields or getters, extension properties, and companion or `object` members.
- Method calls with overloads, boxing and default arguments.
- Kotlin stdlib extensions such as `list.first()`, `map.getValue(k)` and `s.isNotBlank()`, plus your own top-level and extension functions.
- Indexing on arrays, lists, maps and strings.
- Arithmetic, comparisons, `&&`, `||`, `!`, `==`, `===`, `?.`, `?:`, `!!`, `is`, `in`, `as` and `as?`.
- String templates and assignment (`x = 5`).

Not supported: lambdas, `if` or `when` expressions, and object construction.

## Build and install

Prerequisites: JDK 17+ for the adapter (JDK 21 recommended), Maven 3.9+, Node.js 18+, and VS Code 1.85+.

```bash
cd kotlin-debug-plugin
./scripts/build.sh            # adapter tests + build; add --skip-tests for a quick build
code --install-extension dist/kotlin-debugger-2.0.0.vsix
```

You can also install from VS Code: **Extensions** › **…** › **Install from VSIX…** › `dist/kotlin-debugger-2.0.0.vsix`, then reload the window.

The VSIX is self-contained: it bundles the adapter as a single jar and needs no downloads. The adapter
runs on a JDK it finds through `kotlinDebugger.javaHome`, `JAVA_HOME`, `java` on `PATH`, or `/usr/libexec/java_home` on macOS.

> If the old **fwcd.kotlin** extension is installed, it still works for syntax and language
> features. This debugger uses its own debug type, `kotlin-jvm`, so the two no longer fight over
> the `kotlin` debug type. Change `"type": "kotlin"` to `"type": "kotlin-jvm"` in existing launch configurations.

## Start your JVM with a debug port

Add the JDWP agent to the JVM that runs your app (JDK 9+ syntax):

```
-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005
```

> In zsh (the macOS default shell) quote the argument, e.g. `java '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005' -jar app.jar`. Unquoted, `*` is a filename glob and zsh fails with *no matches found*.

- `address=*:5005` listens on all interfaces. Use `address=127.0.0.1:5005` (or `localhost:5005`) to accept local connections only, for example with an SSH tunnel. A bare `5005` also binds to localhost only on JDK 9+.
- `suspend=y` makes the JVM wait for the debugger before running `main`. Use it to debug startup code; the debugger resumes the JVM once breakpoints are installed.
- *Optional:* `includevirtualthreads=y` also lists idle virtual threads in the Threads view. Stopped virtual threads are always shown.

| How you run Spring Boot | Debug arguments |
|---|---|
| Jar | `java '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005' -jar app.jar` |
| Maven | `mvn spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"` |
| Gradle | `./gradlew bootRun --debug-jvm` (port 5005, waits for the debugger), or `tasks.bootRun { jvmArgs("-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005") }` |
| Docker / any launcher | `ENV JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"` and publish the port (`-p 5005:5005`) |
| Kubernetes | Set `JAVA_TOOL_OPTIONS` as above, then `kubectl port-forward pod/<pod> 5005:5005` |
| Remote VM over SSH | Start with `address=127.0.0.1:5005`, then `ssh -L 5005:127.0.0.1:5005 user@host` |

> ⚠️ A JDWP port gives full control over the JVM. Never expose it on an untrusted network. Use a tunnel or port-forward.

## VS Code configuration

Open the folder that contains the app's sources (the Spring Boot project or the monorepo root). Then add to `.vscode/launch.json`:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "kotlin-jvm",
      "request": "attach",
      "name": "Attach to Spring Boot (Kotlin)",
      "hostName": "localhost",
      "port": 5005,
      "projectRoot": "${workspaceFolder}"
    },
    {
      // Optional: let the debugger start the app (classpath via Maven/Gradle)
      "type": "kotlin-jvm",
      "request": "launch",
      "name": "Launch Spring Boot (Kotlin)",
      "mainClass": "com.example.demo.DemoApplicationKt",
      "projectRoot": "${workspaceFolder}",
      "args": ["--server.port=8080"],
      "vmArgs": "-Xmx1g -Dspring.profiles.active=dev"
    }
  ]
}
```

- If the sources live in several repositories or modules outside `projectRoot`, add them with `"sourcePaths": ["../shared-lib/src/main/kotlin"]`.
- With no `launch.json`, pressing F5 and choosing **Kotlin (JVM)** attaches to `localhost:5005`.
- The **Kotlin Debugger: Attach to JVM (host:port)…** command attaches without editing `launch.json`.

## Attach and debug

1. Start the app with the JDWP argument from [Start your JVM with a debug port](#start-your-jvm-with-a-debug-port). Spring Boot logs `Listening for transport dt_socket at address: 5005`.
2. In VS Code, open the project, select **Attach to Spring Boot (Kotlin)** in Run and Debug, and press F5. The Debug Console shows `Kotlin debugger 2.0.0 attached to OpenJDK … 21… — N source files indexed`.
3. Set breakpoints in `.kt` files. They turn solid red (verified) as soon as the class is loaded. Breakpoints in classes that load later bind automatically.
4. Trigger the code, for example with an HTTP request. Execution stops on your `.kt` line, and the Variables view, Call Stack and Debug Console work as usual.
5. **Disconnect** (Shift+F5) detaches and leaves the app running. Breakpoints are removed and all threads resume.

Breakpoints suspend only the thread that hit them by default, so a server keeps serving other requests. Set `"suspendAllThreads": true` to freeze the whole JVM.

## Kotlin compiler settings

No special settings are needed. Kotlin always emits the line numbers, local variable tables and
SMAP data the debugger uses. Recommendations:

- **Do not strip debug info.** Avoid ProGuard or R8 and `-g:none`-style tooling on builds you debug.
- **Coroutine variables.** In optimized builds the compiler may clear locals that are no longer needed after a suspension point, so they show as missing. For development builds add `-Xdebug`, which keeps them. Do not use it in production builds.
  - Gradle: `kotlin { compilerOptions { freeCompilerArgs.add("-Xdebug") } }`
  - Maven (`kotlin-maven-plugin`): `<configuration><args><arg>-Xdebug</arg></args></configuration>`
- **Matching sources.** The running bytecode must be built from the sources you have open. The debugger maps by file name and package, so the absolute build path does not matter, but stale sources mean wrong lines.
- The Kotlin 2.x defaults (invokedynamic lambdas, JVM target 21) are fully supported.

## Configuration reference

### `launch.json` attributes

| Attribute | Default | Meaning |
|---|---|---|
| `hostName` (attach) | `localhost` | JVM host |
| `port` (attach) | — | JDWP port |
| `timeout` (attach) | `30000` | Milliseconds to keep retrying the connection |
| `projectRoot` | workspace folder | Folder searched recursively for `.kt` and `.java` sources (skips `build/`, `target/`, `node_modules/`, `.git/`) |
| `sourcePaths` | `[]` | Extra source roots |
| `mainClass` (launch) | — | For example `com.example.AppKt` |
| `classPaths` (launch) | auto | Explicit runtime classpath. Otherwise Maven `dependency:build-classpath` or Gradle `runtimeClasspath` |
| `vmArgs`, `args` (launch) | — | String or array |
| `cwd`, `env`, `javaExec` (launch) | — | Debuggee working directory, environment, and `java` binary |
| `stepFilters` | `[]` | Extra classes to skip on step into, such as `com.acme.generated.*` |
| `stepFiltersReplaceDefaults` | `false` | Use only `stepFilters`, without the JDK, Kotlin and Spring defaults |
| `suspendAllThreads` | `false` | Suspend every thread when a breakpoint hits |
| `showToString` | `true` | Show `toString()` for project classes (for example data classes) and value types |
| `asyncStackTraces` | `true` | Show coroutine callers |
| `coroutineStepping` | `true` | Make step over a suspension point continue in the same coroutine |
| `invocationTimeout` | `5000` | Milliseconds allowed for a debuggee method call during evaluation |
| `logLevel` | setting | `ERROR` … `TRACE` |

### VS Code settings

| Setting | Meaning |
|---|---|
| `kotlinDebugger.javaHome` | JDK (17+) that runs the adapter |
| `kotlinDebugger.adapterJvmArgs` | JVM options for the adapter (default `-Xmx512m`) |
| `kotlinDebugger.logLevel` | Adapter log level. **Kotlin Debugger: Show Debug Adapter Log** opens the log |
| `kotlinDebugger.traceProtocol` | Log every DAP message to the *Kotlin Debugger* output channel |

## Known limitations

- **Coroutines**
  - What works: breakpoints, variables, the async call stack (callers reconstructed from the continuation chain), and step over a suspension point.
  - There is no "Coroutines" panel listing all coroutines and their states.
  - *Step Into* a suspending call that suspends immediately, and *Step Out* of a suspended function, behave like plain JVM stepping and may stop in the resuming caller.
  - Async frames show positions only. Their variables appear as raw continuation fields (`L$0`, `I$0` …).
  - Locals the compiler dropped after a suspension point need `-Xdebug` (see [Kotlin compiler settings](#kotlin-compiler-settings)).
  - Building the async stack calls `getStackTraceElement()` in the debuggee. That only works when the thread stopped at a breakpoint or step, not after *Pause*.
- **Inline functions**
  - A breakpoint inside an inline function binds wherever the function is inlined in loaded classes.
  - The call stack shows one virtual frame for the innermost inline function. Intermediate frames of nested inlines (inline calling inline) are not reconstructed.
  - A breakpoint on a one-line `list.forEach { … }` stops before the loop, not in each lambda invocation. Put the lambda body on its own line to stop per element.
- **Lambdas and generated code.** JVM-generated lambda proxies, CGLIB and JDK proxies, and bridge or `$default` methods are stepped through and shown de-emphasized. They have no Kotlin source.
- **Evaluation**
  - The evaluator handles a Kotlin subset (see [Features](#features)) and does not compile Kotlin code.
  - Inline functions with lambda parameters (`map { }`, `filter { }`) cannot be called, because they do not exist as callable methods at runtime.
  - Evaluation runs methods on the stopped thread. Side effects are real, and a call that blocks is interrupted after `invocationTimeout`.
- **Spring proxies.** `this` inside a bean method is the target bean, not the proxy. Breakpoints in proxied beans work; the proxy and interceptor frames appear in the stack as `(Spring proxy)` and framework frames.
- **Hot reload.** HotSwap and class redefinition are not implemented. Use Spring Boot DevTools, which restarts the application context: breakpoints re-bind automatically to reloaded classes. Alternatively restart the JVM.
- **Source mapping.** Breakpoints need the running classes to come from the open sources. Mismatched sources give wrong or unverified lines. Library code without sources in the workspace shows as de-emphasized frames with no editor (source jars are not attached).
- **Not implemented:** data and field watchpoints, Restart Frame, Jump to Cursor (`goto`), a disassembly view, and column breakpoints on lambdas within a line. Run to Cursor works.
- **JDWP** allows one debugger connection per JVM at a time.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not attach to JVM at host:port … connection refused` | The JVM isn't listening, or the port isn't reachable. Check the startup log for `Listening for transport dt_socket at address`, the container port mapping, and that `address=*:` is used when connecting from another host |
| `JDWP handshake failed` | Another debugger (IntelliJ, another VS Code window) is already attached, or the port isn't a JDWP port |
| Breakpoint stays hollow with "Pending: no loaded class contains …" | The class hasn't been loaded yet, which is normal until that code runs. If it never binds, the running build doesn't contain that code (stale build), or the file is outside `projectRoot`/`sourcePaths` |
| `No suitable JDK found` / adapter exits immediately | Set `kotlinDebugger.javaHome` to a full JDK 17+ (a JRE without `jdk.jdi` won't work) |
| Variables missing in `suspend` functions | Compile with `-Xdebug` for development builds |
| Need details | Set `"logLevel": "DEBUG"` in `launch.json`, then run **Kotlin Debugger: Show Debug Adapter Log**. `kotlinDebugger.traceProtocol` logs DAP traffic |

## Development and tests

```
adapter/                     Kotlin debug adapter (Maven): DAP via LSP4J, JDI/JDWP
  src/main/kotlin/dev/ktdebug/
    dap/KotlinDebugServer.kt   DAP requests/events
    session/                   JDI session, event loop, breakpoints, stepping, sources, connect
    jdi/                       Kotlin strata/SMAP helpers, stack frames, value rendering
    eval/                      Kotlin expression lexer/parser/evaluator
  src/fixtures/kotlin/       debuggee fixtures (classes, lambdas, inline, coroutines, …)
  src/test/kotlin/           unit tests + DAP→JDWP integration tests (+ Spring Boot)
extension/                   VS Code extension (TypeScript) + real-VS-Code E2E test
samples/spring-boot-kotlin-demo/   realistic Spring Boot 3.5 / Kotlin / coroutines app
scripts/build.sh             build + package VSIX into dist/
scripts/test.sh              all tests including the VS Code E2E
docs/ARCHITECTURE.md         design and decisions
```

```bash
./scripts/test.sh     # sample build, adapter tests (unit, DAP/JDWP, Spring Boot), VS Code E2E
```

The tests launch real JVMs with `-agentlib:jdwp`, attach the adapter over JDWP and drive it through
the DAP wire protocol. The VS Code E2E test runs a real VS Code instance against the Spring Boot
sample. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
