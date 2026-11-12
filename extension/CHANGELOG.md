# Changelog

## 2.4.0

- **Run | Debug** above every top-level `fun main`. A Maven project is compiled first (`mvn compile` with the Project JDK; `kotlinDebugger.run.buildBeforeLaunch`), then the main class starts through the `kotlin-jvm` launch configuration with the classpath read from the build files. `kotlinDebugger.run.codeLens` hides the lenses.
- **Kotlin tests of Maven projects in the Testing view and the gutter**: classes with `@Test` functions below `src/test` (JUnit 4/5, kotlin.test, nested classes, backticked names). Run and Debug go through Maven (`-Dtest=Class#method`) with the Project JDK; results, failure messages and the failing line come from the Surefire reports. `kotlinDebugger.testing.enabled` turns it off.
- **Compile on save** (`kotlinDebugger.maven.compileOnSave`, off by default): saving a Kotlin or Java file of a Maven project runs `mvn -q compile` in the background and shows the compiler's errors and warnings as problems.
- **Kotlin: Organize Imports** sorts the imports by the import layout and drops duplicates and unused imports. It keeps star imports, operator and delegate functions, and names that only appear in comments (KDoc links). It also answers VS Code's Organize Imports (`Shift+Alt+O`, on save) unless the Kotlin Jump extension is installed, which has its own; `kotlinDebugger.imports.organize` decides.

## 2.3.0

- **Maven view** in the activity bar, for every `pom.xml` of the workspace (modules hang below their parent):
  - **Lifecycle** (clean, validate, compile, test, package, verify, install, site, deploy), **Plugins** with the goals each plugin really has (read from the plugin's descriptor in the local repository), **Dependencies**, **Profiles** (checkboxes) and **Run Configurations** (goals you saved).
  - Run with the run button or a double-click; **Execute Maven Goal…** takes any command line and remembers earlier ones; **Maven Options** switches offline, skip tests, update snapshots and debug output for every run.
  - Kotlin and Java compiler errors of a run appear in the Problems panel and open the file at the line.
  - **Debug** on a goal starts it with the JVM waiting for the debugger and attaches the Kotlin debugger: the application for `spring-boot:run`, the test JVM for `test`/`verify`, Maven's own JVM otherwise. Stopping the session stops Maven.
- **Project JDK**: you choose the JDK of a workspace folder in the Maven view, the status bar or with **Kotlin: Select Project JDK…**. The list has every JDK found on the machine (`JAVA_HOME`, the system locations, Homebrew, SDKMAN, asdf, mise, jenv, `~/.jdks`, Gradle toolchains, `kotlinDebugger.jdks`), marks the one that matches the Java version of the `pom.xml`, and lets you browse for another.
  - Every Maven run from the view uses it (`JAVA_HOME` and `PATH`). The first run asks when none is chosen yet; nothing is picked silently.
  - Once chosen, completion reads the JDK classes from it and a `kotlin-jvm` launch without `javaExec` starts the app with it. The choice is saved as `kotlinDebugger.projectJdk` in the folder's settings.
- Maven itself: `kotlinDebugger.maven.executable` when set, else the project's `mvnw`, else the Maven 3.9 that now ships inside the extension, else `mvn` on `PATH`. Nothing is downloaded by the extension.
- New settings: `kotlinDebugger.projectJdk`, `kotlinDebugger.jdks`, `kotlinDebugger.maven.executable`, `kotlinDebugger.maven.arguments`.

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
