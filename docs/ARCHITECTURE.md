# Architecture

```
┌──────────── VS Code ────────────┐         ┌──────── kotlin-debug-adapter.jar (JDK 17+) ────────┐        ┌──── debuggee JVM ────┐
│ extension (TypeScript)          │  DAP    │ dap/KotlinDebugServer   ← LSP4J DAP over stdio     │ JDWP   │ -agentlib:jdwp=…     │
│  • finds a JDK, starts adapter  │◀──────▶│ session/DebugSession    JDI event loop, threads,    │◀─────▶│ JDK 21, Spring Boot,  │
│  • fills launch.json defaults   │ stdio   │                         stepping, invocation        │ socket │ Kotlin bytecode +     │
│  • optional protocol tracing    │         │ session/BreakpointManager  source→locations (SMAP)  │        │ SMAP (SourceDebug-    │
│  • Attach command               │         │ session/SourceIndex     (package, file) ↔ local path │        │ Extension)            │
└─────────────────────────────────┘         │ jdi/StackBuilder, Values  Kotlin frames & variables │        └──────────────────────┘
                                            │ eval/Parser, Evaluator  Kotlin expressions over JDI │
                                            └─────────────────────────────────────────────────────┘
```

## Why a new adapter

The previous implementation was a fork of fwcd/kotlin-debug-adapter with these defects:

- The shipped VSIX contained no adapter, and the Maven build produced an empty jar because its source directory was wrong.
- It did not compile on its own: it depended on an undeclared kotlin-language-server module.
- It guessed classes from file names (`Foo.kt` → `Foo`/`FooKt`). Every class or lambda whose name differs from its file was missed, and only the first location of a line was used.
- It shared the `kotlin` debug type and `kotlin.*` settings with the fwcd.kotlin extension, so whichever extension activated first owned debugging.
- It had no virtual-thread, condition, logpoint or coroutine support.

The rewrite keeps the mature parts: the JDK's own **JDI/JDWP** stack for VM control and Eclipse **LSP4J** for the DAP protocol. Only the Kotlin knowledge is new code.

**Reusing Microsoft java-debug was considered and rejected.** Its breakpoint model resolves
*class names* through the JDT Java language server, and its evaluation engine compiles Java with
JDT. Neither understands Kotlin files, inline functions or coroutines, so the Kotlin-specific parts
would have had to replace most of it anyway.

## Breakpoint resolution (the core fix)

A Kotlin file compiles to many classes (`FooKt`, `Foo`, `Foo$Companion`, `Foo$bar$1`, indy lambda
methods `bar$lambda$0`, …). Inline functions copy their bytecode into *other* classes, possibly in
other packages. So breakpoints are resolved by **source file**, not by class name:

1. **Map the file to its identity.** `SourceIndex` reads the `package` directive of the file, so the directory layout doesn't matter, and the key becomes `com/example/OrderService.kt`.
2. **Register for future classes.** A `ClassPrepareRequest` with `addSourceNameFilter("OrderService.kt")` makes the JDWP agent in the debuggee report every class whose `SourceFile` attribute *or any SMAP file entry* matches. That includes classes into which this file's inline functions were inlined. The filtering happens VM-side, so it stays cheap even in a 30k-class Spring app.
3. **Bind already-loaded classes.** From a short-lived `allClasses()` snapshot (taken after the prepare request exists), only same-package classes are checked, because all classes of a Kotlin file share its package. When the file declares `inline` functions, classes in other project packages are checked too.
4. **Compute locations per class.** `ReferenceType.locationsOfLine("Kotlin", "OrderService.kt", line)` uses the class's SMAP **Kotlin stratum**, so lines of inlined code resolve correctly. Each location's stratum source path is checked against the expected package, which keeps same-named files in different packages apart.
5. **Drop bookkeeping duplicates.** A line can own several line-table entries. Genuine repeats such as loop headers and duplicated `finally` blocks are kept. These are dropped:
   - the re-entry of an inline call site after the inlined body returns;
   - the re-entry of a line inside an inline body after an inline lambda ran;
   - the resume-path copy of a call line in a coroutine state machine, which comes right after code Kotlin attributes to the function's declaration line.

Breakpoints report `verified=false` with a message until a class is bound, and a DAP `breakpoint`
event updates them later. Conditions, hit conditions and logpoints run on a worker thread, never
on the JDI event loop. A method invocation can trigger nested events (class loading, other
breakpoints) that the loop must keep processing; hits on a thread that is currently evaluating are
auto-resumed.

## Source mapping for frames

For each frame the **Kotlin stratum** gives the source name and line. The SMAP file path is a class internal name, such as `com/example/util/TimingKt`, so its directory is the package. `(package, file)` is then looked up in `SourceIndex`. This works for remote JVMs whose build paths differ from the local checkout.

When a location is **inside an inlined body**, the Kotlin stratum and the plain Java line table disagree. The stack then shows two frames:

- a virtual `inlineFun (inlined)` frame at the inline function's real file and line;
- the real frame at the call site, from the `KotlinDebug` stratum.

Variables are split by Kotlin's `$iv` suffixes. Locals of the inline function appear in the inline frame and the caller's locals in the real frame. The `$i$f$`/`$i$a$` markers are hidden.

## Stepping

Plain JDI `StepRequest`s (line granularity), plus Kotlin-specific continuation rules evaluated on each step event:

- **Step Into** uses class exclusion filters: JDK, Kotlin, kotlinx, Spring, CGLIB patterns, common libraries, and user `stepFilters`. Landing in code without workspace sources adds that library package to the filters and continues. The JDWP agent then skips whole libraries using method-entry events instead of single-stepping, which is what makes stepping from a controller into a `@Transactional`/AOP-proxied service fast.
- **Step Over** at a call-site line continues while the location is inside an inline function body, so inline bodies are skipped. Inline lambda lines still stop.
- Locations with no line number, bridges, `$default`/`access$` methods and lambda proxy classes are stepped through.
- **Coroutines**, for step over inside a `suspend fun` or `invokeSuspend`:
  - Before resuming, the adapter installs a `MethodExitRequest` on the frame plus line breakpoints on the function that act as resume watchers. For suspend lambdas these use an instance filter on the continuation; for named functions they check `$continuation`.
  - If the frame returns `COROUTINE_SUSPENDED`, the plain step is cancelled. The first watcher hit by the *same* continuation, on any thread, finishes the step on the next real line.
  - The watchers exist before the thread runs, so a resume on another dispatcher thread (`delay()`'s timer) can't be missed.
  - Code attributed to the declaration line (dispatch, the suspended return) never counts as a step stop.

## Coroutine async stacks

When a frame is `invokeSuspend` called from `BaseContinuationImpl.resumeWith` (a resumed
coroutine), the adapter follows `completion` links and calls `getStackTraceElement()` on each
continuation. That method uses `@DebugMetadata`, the same data kotlinx.coroutines uses for stack
recovery. The logical callers (e.g. `OrderService.quote`, `OrderController.quote`) appear below
a label frame. Without an event-suspended thread, the class name is shown without a line.

## Threads, suspension and invocation

- Breakpoints use `SUSPEND_EVENT_THREAD` by default, so servers keep running. Pause uses `vm.suspend()`. Continue resumes exactly what was suspended: the event set, or the whole VM after a pause.
- Virtual threads (JDK 21) are not returned by `allThreads()`, so stopped threads are always added to the thread list. `ThreadStart`/`ThreadDeath` requests use `addPlatformThreadsOnly()` when available to avoid an event flood.
- Method invocation (evaluation, `toString`, collection views, async stacks) uses `INVOKE_SINGLE_THREADED` with a watchdog that interrupts after `invocationTimeout`.
  - Results are pinned with `disableCollection()` until the thread resumes.
  - `ClassNotLoadedException`, raised when a JDK type was never requested through the app class loader, is fixed by `Class.forName` through that loader, followed by a retry.
- Frames, variable references and cached stacks are owned by their thread and dropped when it resumes. Other stopped threads keep theirs.

## Expression evaluator

A recursive-descent parser handles a Kotlin subset with Kotlin precedence. The interpreter works on
JDI mirrors and resolves names in this order:

1. Locals, using Kotlin display names and the right inline level.
2. Captured `$x` fields.
3. `this` members, then outer `this$0` members.
4. Statics, companion and `object` members.
5. Classes.

Properties map to fields or getters, and extension properties to facade getters. Calls pick an
overload with boxing and unboxing; `name$default` handles default arguments. Extension functions
are looked up on stdlib facades and on project file facades, which are loaded on demand with
`Class.forName` when the app has not touched them yet. Primitive and string operations are
computed locally without running debuggee code.

## Extension

- **Debug type `kotlin-jvm`.** It is unique, so the extension coexists with fwcd.kotlin.
- **JDK discovery.** In order: `kotlinDebugger.javaHome`, then `JAVA_HOME`, then `PATH`, then macOS `java_home`. A candidate must be version 17+ and have the `jdk.jdi` module.
- **Adapter process.** Starts as `java -jar server/kotlin-debug-adapter.jar` (a shaded jar) and logs to `$TMPDIR/kotlin-debug-adapter/adapter.log`.
- **Configuration provider.** Fills defaults: `projectRoot` is the workspace folder, `hostName` defaults to `localhost`, and F5 without a `launch.json` attaches to 5005. It also validates `port` and `mainClass`.
- **Completion (`src/completion/`).** Pure TypeScript. No JVM, build tool or npm dependency is used, so it works as soon as the extension loads.
  - `classpath.ts` finds the nearest `pom.xml` or Gradle build and resolves the classpath from the local caches. For Maven it reads the parent chain, interpolates properties with the child's values (so overriding `kotlin.version` changes managed versions), imports BOMs, and walks dependencies breadth-first with nearest-wins mediation, exclusions, `optional` and scopes. It also handles reactor modules. On the playground it matches `mvn dependency:build-classpath` exactly. The JDK is located without running `java`.
  - `archives.ts` reads jars (zip central directory plus inflate), class directories and the JDK's `lib/modules` jimage. Jimage packages that their module doesn't export are hidden.
  - `classfile.ts` parses class files and renders descriptors and generic signatures as Kotlin types (`Comparator<in T>`, `(T) -> R`, `IntArray`, `suspend`). Parameter names come from `MethodParameters` or the `LocalVariableTable`.
  - `classIndex.ts` handles `ClassName.` and `package.`. It resolves the qualifier the way Kotlin does: explicit and alias imports, same package, star imports, then default imports. It falls back to any class with that simple name, and the completion adds the import. It lists statics, enum constants and nested classes. A Kotlin `object` or companion contributes its members, with getters shown as properties.
  - `kotlinMetadata.ts` decodes `@kotlin.Metadata` and the stdlib's `.kotlin_builtins`. Both are protobuf; `d2` and the JVM string-table records (including the 44 predefined `kotlin/…` names) give the names. It yields Kotlin classes, functions, properties, type aliases and extension receivers with full Kotlin types: nullability, `List` vs `MutableList`, `T.() -> R`, `suspend`, defaults, varargs. `@InlineOnly` functions, which are private in bytecode, are included. Functions deprecated with `level = HIDDEN` are dropped by matching the bytecode method.
  - `types.ts` holds the Kotlin type model: rendering, substitution, unification, and the compiler's Java-to-Kotlin class mapping (`java.util.List` is `MutableList` in Java signatures).
  - `typeSystem.ts` builds class models from built-ins, Kotlin metadata, Java class files and project sources. It walks supertypes with substituted type arguments. It shows Java members as Kotlin does: getters become synthetic properties; JDK methods replaced by built-in members are hidden (`size()` is `size`, `charAt` is `get`); allowed JDK defaults are added to the mapped built-ins (`stream()`, `removeIf`). It indexes every top-level declaration of the classpath by receiver. An extension applies when its receiver class is in the type's supertypes and its type arguments fit, and its type parameters are then bound (`Iterable<T>.map` on `List<Todo>` gives `(Todo) -> R`). Members shadow extensions with the same signature.
  - `inference.ts` types the expression before the `.`. It works on the document with comments and strings masked: a backward scan finds the postfix chain, which is evaluated left to right. Sources of types are declarations, parameters, `for`, destructuring, lambda parameters, `this`, constructors with inferred type arguments, binary and infix operators, casts and `?:`. Calls bind the function's type parameters from arguments and from a trailing lambda's last expression. Results are memoized per request. The same scanner parses Kotlin declarations (classes, members, top-level functions) for `sources.ts` and finds the enclosing call for parameter hints.
  - `sources.ts` keeps the project's `.kt` files (editor text for open files) as class models. Source declarations win over compiled ones; compiled members supply types the source leaves to inference.
  - `provider.ts` keeps one index per build root and caches parsed archives by path and mtime. It rebuilds after build files or `.class` files change, and refreshes sources on every request and on `.kt` saves.

## Tests

| Suite | What it proves |
|---|---|
| `adapter` unit tests | Parser, hit conditions, Kotlin name mangling, source index, config, frame names |
| `AttachDebugTest` (14) | DAP client → adapter process → JDWP → JDK 21 fixtures. Covers class, top-level, companion, inline (cross-file), lambda, SAM, anonymous, extension, generic and sealed code; exceptions; coroutines (async stack, step over suspension); conditions, hit counts and logpoints; function breakpoints; set variable; pause; attach to a running JVM; detach |
| `LaunchDebugTest` (2) | Launch mode, output capture, exit code, attach error messages |
| `SpringBootDebugTest` (5) | Spring Boot 3.5 app as `java -jar` with real HTTP traffic. Covers the controller → CGLIB/AOP → service chain, the inline helper, extension functions, suspend endpoints with a conditional breakpoint and async stack, exceptions caught by Spring, virtual threads, detach, and launch with a Maven classpath |
| Extension E2E | A real VS Code instance attaches to the Spring Boot JVM through `vscode.debug.startDebugging`, then exercises breakpoints, editor navigation, stack, variables, evaluate, Step Over, Run to Cursor and detach |
| Completion E2E (`KDA_E2E_SUITE=completion`) | `vscode.executeCompletionItemProvider` / `executeSignatureHelpProvider` in the sample. Static side: Spring statics with parameter names, JDK classes through default imports, auto-import of a class that isn't imported, Kotlin `object` properties, a project companion `const val`, package paths. Instance side: `ArrayList<String>` members and stdlib extensions with bound generics, read-only `List`, chains through data classes, lambda result types, a project extension property with auto-import, classes typed in the editor but not compiled, parameter hints with positional and named arguments, and completion without a dot (typed locals, constructor properties, top-level functions, auto-imported classes, named arguments) |
