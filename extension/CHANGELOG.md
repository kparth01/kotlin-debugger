# Changelog

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
