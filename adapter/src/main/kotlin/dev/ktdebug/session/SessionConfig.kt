package dev.ktdebug.session

import java.nio.file.Path
import java.nio.file.Paths

/** Debug configuration (the `launch.json` entry), normalized. */
data class SessionConfig(
    val request: String,                       // "attach" | "launch"
    val projectRoot: Path?,
    val sourcePaths: List<Path>,
    // attach
    val hostName: String,
    val port: Int,
    val timeoutMs: Int,
    // launch
    val mainClass: String?,
    val classPaths: List<String>?,
    val modulePaths: List<String>?,
    val vmArgs: List<String>,
    val args: List<String>,
    val cwd: Path?,
    val env: Map<String, String>,
    val javaExec: String?,
    // behaviour
    val stepFilters: List<String>,
    val suspendAllThreads: Boolean,
    val showToString: Boolean,
    val asyncStackTraces: Boolean,
    val coroutineStepping: Boolean,
    val invocationTimeoutMs: Long,
    val noDebug: Boolean,
) {
    val isAttach get() = request == "attach"

    companion object {
        /** Classes that "step into" never stops in; stepping continues to the next user frame. */
        val DEFAULT_STEP_FILTERS = listOf(
            "java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "jakarta.*",
            "kotlin.*", "kotlinx.*",
            "org.springframework.*", "org.apache.catalina.*", "org.apache.tomcat.*", "org.apache.coyote.*",
            "io.micrometer.*", "reactor.*", "io.netty.*", "org.aopalliance.*", "net.bytebuddy.*",
            "com.fasterxml.*", "tools.jackson.*", "org.hibernate.*", "ch.qos.logback.*", "org.slf4j.*",
            "org.junit.*", "org.mockito.*", "io.mockk.*", "org.aspectj.*", "io.opentelemetry.*", "com.zaxxer.*",
            "io.projectreactor.*", "org.reactivestreams.*", "org.yaml.*", "com.google.*", "org.jboss.*",
            "*\$\$SpringCGLIB\$\$0", "*\$\$SpringCGLIB\$\$1", "*\$\$SpringCGLIB\$\$2", "*\$\$SpringCGLIB\$\$3",
            "*\$\$FastClassBySpringCGLIB*",
        )

        fun from(request: String, a: Map<String, Any?>, defaultRoot: Path? = null): SessionConfig {
            val root = a.str("projectRoot")?.let { Paths.get(it) } ?: a.str("cwd")?.let { Paths.get(it) } ?: defaultRoot
            val extraSteps = a.strList("stepFilters") ?: emptyList()
            val stepFilters = if (a["stepFiltersReplaceDefaults"] == true) extraSteps else DEFAULT_STEP_FILTERS + extraSteps
            return SessionConfig(
                request = request,
                projectRoot = root,
                sourcePaths = (a.strList("sourcePaths") ?: emptyList()).map { Paths.get(it) },
                hostName = a.str("hostName") ?: a.str("host") ?: "localhost",
                port = a.num("port")?.toInt() ?: 5005,
                timeoutMs = a.num("timeout")?.toInt() ?: 30_000,
                mainClass = a.str("mainClass"),
                classPaths = a.strList("classPaths") ?: a.strList("classpath"),
                modulePaths = a.strList("modulePaths"),
                vmArgs = a.argList("vmArgs") ?: a.argList("vmArguments") ?: emptyList(),
                args = a.argList("args") ?: emptyList(),
                cwd = a.str("cwd")?.let { Paths.get(it) },
                env = (a["env"] as? Map<*, *>)?.entries?.associate { it.key.toString() to it.value.toString() } ?: emptyMap(),
                javaExec = a.str("javaExec"),
                stepFilters = stepFilters,
                suspendAllThreads = a["suspendAllThreads"] == true,
                showToString = a["showToString"] != false,
                asyncStackTraces = a["asyncStackTraces"] != false,
                coroutineStepping = a["coroutineStepping"] != false,
                invocationTimeoutMs = a.num("invocationTimeout")?.toLong() ?: 5_000L,
                noDebug = a["noDebug"] == true,
            )
        }

        private fun Map<String, Any?>.str(k: String) = (this[k] as? String)?.takeIf { it.isNotBlank() }
        private fun Map<String, Any?>.num(k: String): Number? = when (val v = this[k]) {
            is Number -> v
            is String -> v.toDoubleOrNull()
            else -> null
        }
        private fun Map<String, Any?>.strList(k: String): List<String>? = when (val v = this[k]) {
            is List<*> -> v.mapNotNull { it?.toString() }
            is Array<*> -> v.mapNotNull { it?.toString() }
            is String -> v.split(java.io.File.pathSeparatorChar).filter { it.isNotBlank() }
            else -> null
        }
        /** Accepts either a JSON array or a single shell-like string. */
        private fun Map<String, Any?>.argList(k: String): List<String>? = when (val v = this[k]) {
            is List<*> -> v.mapNotNull { it?.toString() }
            is String -> splitArgs(v)
            else -> null
        }

        fun splitArgs(s: String): List<String> {
            val out = mutableListOf<String>()
            val cur = StringBuilder()
            var quote: Char? = null
            var any = false
            for (c in s) {
                when {
                    quote != null && c == quote -> quote = null
                    quote == null && (c == '"' || c == '\'') -> { quote = c; any = true }
                    quote == null && c.isWhitespace() -> { if (cur.isNotEmpty() || any) out += cur.toString(); cur.clear(); any = false }
                    else -> cur.append(c)
                }
            }
            if (cur.isNotEmpty() || any) out += cur.toString()
            return out
        }
    }
}
