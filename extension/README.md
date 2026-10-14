# Kotlin Debugger (JVM)

Debug Kotlin/JVM and Spring Boot applications in VS Code.

![Kotlin Debugger demo](https://github.com/kparth01/kotlin-debugger/raw/HEAD/extension/demo.gif)

## Installation

Search **Kotlin Debugger** in the VS Code Extensions sidebar and click **Install**, or run:

```
code --install-extension kparth01.kotlin-debugger
```

To install from a VSIX file, use **Extensions › … › Install from VSIX…**, or run
`code --install-extension kotlin-debugger-2.1.0.vsix`.

## Supported versions

| | Version |
|---|---|
| VS Code | 1.85+ |
| JDK that runs the debugger | 17+ (a full JDK, not a JRE). Found through `kotlinDebugger.javaHome`, `JAVA_HOME` or `java` on `PATH` |
| JVM of your app | Any JVM with JDWP. Tested with JDK 21 |
| Kotlin | 2.x. Tested with 2.4.0 |

Usage, configuration and troubleshooting are in the [project README](https://github.com/kparth01/kotlin-debugger#readme).
