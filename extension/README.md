# Kotlin Debugger (JVM)

Debug Kotlin/JVM and Spring Boot applications in VS Code. Attach to any JVM started with JDWP,
set breakpoints in `.kt` files, and step, inspect and evaluate in Kotlin terms.

## Installation

Search **Kotlin Debugger** in the VS Code Extensions sidebar and click **Install**, or run:

```
code --install-extension kparth01.kotlin-debugger
```

**Prerequisite:** JDK 17+ must be available (`JAVA_HOME`, or `java` on `PATH`). The debuggee can
be any JVM version with JDWP. If your JDK is in a non-standard location, set
`kotlinDebugger.javaHome` in VS Code settings.

## Quick start

1. Start your app with a JDWP debug port:

   ```
   java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 -jar app.jar
   ```

   For Spring Boot + Maven:

   ```
   mvn spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
   ```

2. Add to `.vscode/launch.json` (or press **F5 → Add Configuration** and pick the Kotlin snippet):

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

3. Press **F5**, set breakpoints in your `.kt` files, and trigger the code.

## Highlights

- Breakpoints in classes, top-level functions, companions, lambdas and anonymous objects, and **inside inline functions**, including inline functions from other files.
- Conditional breakpoints, hit counts, logpoints, function breakpoints, and exception breakpoints (including *Caught exceptions in application code*, useful when Spring catches everything).
- Kotlin-aware stepping that skips inline bodies, Spring and CGLIB proxies, and JDK and library code.
- **Coroutines:** an async call stack of suspended callers, and step over a suspension point that continues in the same coroutine even on another thread.
- Kotlin variable names, data class `toString()`, collections and maps, and virtual threads on JDK 21.
- Kotlin expression evaluation in Watch, Hover and the Debug Console, for example `order.lines.size`, `customer?.name ?: "-"` and `"$id" in ids`.
- **Completion and parameter hints** in `.kt` files, without a JVM or language server:
  - `li.` lists the members of the variable's inferred type the way Kotlin sees them, plus the applicable extension functions with their generics bound (`map(transform: (String) -> R): List<R>`). Chains and lambdas work: `service.all().first().`, `list.map { it.title }.`, `forEach { it. }`.
  - `ClassName.` lists static members, enum entries and companion/`object` members. `org.springframework.` lists packages and classes.
  - Without a dot: locals and parameters with their types, members of `this`, top-level functions, named arguments (`postfix = `), classes and keywords.
  - Classes come from the JDK, your Maven/Gradle dependencies, your compiled classes and your sources, so code you just typed completes too. Picking something that isn't imported adds the import.

Requirements: JDK 17+ for the adapter (a JDK, not a JRE). The debuggee can be any JVM with JDWP. Set `kotlinDebugger.javaHome` if the JDK isn't on `JAVA_HOME` or `PATH`.

Full documentation, Docker and Kubernetes setups, compiler settings and limitations are in the project README.
