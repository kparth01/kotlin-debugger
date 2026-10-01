# Kotlin Debugger (JVM)

Debug Kotlin/JVM and Spring Boot applications in VS Code. Attach to any JVM started with JDWP,
set breakpoints in `.kt` files, and step, inspect and evaluate in Kotlin terms.

## Quick start

1. Start your app with a debug port, for example a Spring Boot jar on JDK 21:

   ```
   java '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005' -jar app.jar
   ```

2. Add to `.vscode/launch.json`:

   ```json
   {
     "type": "kotlin-jvm",
     "request": "attach",
     "name": "Attach to Spring Boot (Kotlin)",
     "hostName": "localhost",
     "port": 5005,
     "projectRoot": "${workspaceFolder}"
   }
   ```

3. Press F5, set breakpoints in your `.kt` files, and trigger the code.

## Highlights

- Breakpoints in classes, top-level functions, companions, lambdas and anonymous objects, and **inside inline functions**, including inline functions from other files.
- Conditional breakpoints, hit counts, logpoints, function breakpoints, and exception breakpoints (including *Caught exceptions in application code*, useful when Spring catches everything).
- Kotlin-aware stepping that skips inline bodies, Spring and CGLIB proxies, and JDK and library code.
- **Coroutines:** an async call stack of suspended callers, and step over a suspension point that continues in the same coroutine even on another thread.
- Kotlin variable names, data class `toString()`, collections and maps, and virtual threads on JDK 21.
- Kotlin expression evaluation in Watch, Hover and the Debug Console, for example `order.lines.size`, `customer?.name ?: "-"` and `"$id" in ids`.

Requirements: JDK 17+ for the adapter (a JDK, not a JRE). The debuggee can be any JVM with JDWP. Set `kotlinDebugger.javaHome` if the JDK isn't on `JAVA_HOME` or `PATH`.

Full documentation, Docker and Kubernetes setups, compiler settings and limitations are in the project README.
