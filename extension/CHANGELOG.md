# Changelog

## 2.1.1

- Shorter Marketplace README with a demo and a table of supported versions. Usage and configuration moved to the project README.
- The license is now MIT.

## 2.1.0

- Completion in Kotlin files, without a JVM, build tool or language server:
  - `value.` lists the members of the expression's inferred type plus the applicable extension functions, with Kotlin types and generics bound.
  - `ClassName.` lists statics, enum entries and companion/`object` members; `package.` lists packages and classes.
  - Without a dot: locals and parameters in scope, members of `this`, top-level functions, named arguments, classes and keywords.
  - Classes come from the JDK, the Maven/Gradle dependencies (resolved from the build files and the local caches), the compiled project and its Kotlin sources, including unsaved editor text. Kotlin declarations are read from `@Metadata` and the stdlib's `.kotlin_builtins`.
  - Classes and extensions that aren't imported add the import.
- Parameter hints for function and constructor calls.
- New settings: `kotlinDebugger.completion.enabled` and `kotlinDebugger.completion.classpath`.

## 2.0.0

Complete rewrite of the adapter and extension.

- New debug type `kotlin-jvm`, which no longer conflicts with the fwcd.kotlin extension. Rename `"type": "kotlin"` in existing launch configurations.
- The adapter ships inside the VSIX as a single jar. Nothing is downloaded.
- Breakpoints resolve by Kotlin source file and package, so all classes and lambdas of a file and inline call sites in other files work.
- Inline function frames and variables, coroutine async stacks, and step over suspension points.
- Conditions, hit counts, logpoints, function breakpoints, and exception filters for application code.
- Kotlin expression evaluator and set variable.
- Kotlin-aware Step Into that skips Spring proxies and libraries.
- JDK 21 virtual threads.
- Attach retries and actionable connection errors. Launch mode resolves the classpath with Maven or Gradle.
