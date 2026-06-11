#!/bin/bash
# Wrapper so VSCode launches our PATCHED kotlin-debug-adapter with a working JDK,
# regardless of how VSCode was launched (GUI apps don't inherit the shell PATH,
# and no JDK is registered system-wide on this machine).
export JAVA_HOME="/opt/homebrew/opt/openjdk@21"
export PATH="$JAVA_HOME/bin:$PATH"
exec "/Users/parth.kansara/Projects/AIProjects/KotlinCompiler/kotlin-debug-adapter/adapter/build/install/adapter/bin/kotlin-debug-adapter" "$@"
