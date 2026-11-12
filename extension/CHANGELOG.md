# Changelog

## 2.2.0

- A completion's new `import` goes to its sorted place instead of below the last import. The order is IntelliJ IDEA's default: other imports, then `java`, `javax`, `kotlin`, then alias imports, each group in ASCII order. `kotlinDebugger.imports.layout` switches to one ASCII-ordered block, and an `ij_kotlin_imports_layout` in `.editorconfig` takes precedence over the setting.
- A class whose simple name already means another class in the file is now offered too. It is inserted fully qualified and no import is added, so the existing name keeps its meaning.
- Imports for code that was typed or pasted without a completion:
  - A name that needs an import is marked in the editor (`kotlinDebugger.imports.highlightMissing`: `hint` by default, `information`, `warning` or `off`). Only names with at least one import candidate are marked: classes, calls of top-level functions, and extension functions or properties on the inferred receiver type.
  - `Alt+Enter` (or the lightbulb, `Cmd+.` / `Ctrl+.`) offers one **Import …** quick fix per candidate, so you choose when a name exists in several packages.
  - **Kotlin: Add Missing Imports** adds every import that has one candidate and asks for the others. The same without questions is available as the `source.addMissingImports` code action, for example in `editor.codeActionsOnSave`.
  - `kotlinDebugger.imports.addUnambiguousOnTheFly` (off by default) adds an import by itself when the name has exactly one candidate and the cursor has left the line.
- The same extension function or property in two packages is listed once per package in the completion list, each with its own import.
- `ClassName.` on a class that is not imported prefers project and library classes over JDK classes with the same name.
- Kotlin files of a deleted folder no longer stay in the completion index.
- The first import of a file is placed below the `package` directive and `@file:` annotations with blank lines around it; a file without a final line break no longer gets the import glued to its last line.

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
