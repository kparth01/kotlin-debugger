package dev.ktdebug.util

import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * Minimal logger. The adapter's stdout is reserved for the DAP wire protocol, so log output goes
 * to stderr (VS Code shows it in the "Kotlin Debugger" log) and optionally to a file. User-visible
 * diagnostics are additionally forwarded to the Debug Console via [consoleSink].
 */
object Log {
    enum class Level { ERROR, WARN, INFO, DEBUG, TRACE }

    @Volatile var level: Level = Level.INFO
    @Volatile private var file: PrintWriter? = null
    @Volatile var consoleSink: ((String) -> Unit)? = null
    private val time = DateTimeFormatter.ofPattern("HH:mm:ss.SSS")

    fun logToFile(path: String) {
        runCatching {
            val f = File(path)
            f.parentFile?.mkdirs()
            file = PrintWriter(f.bufferedWriter(), true)
        }.onFailure { System.err.println("Cannot open log file $path: $it") }
    }

    fun error(msg: String, t: Throwable? = null) = log(Level.ERROR, msg, t)
    fun warn(msg: String, t: Throwable? = null) = log(Level.WARN, msg, t)
    fun info(msg: String) = log(Level.INFO, msg, null)
    fun debug(msg: () -> String) { if (level >= Level.DEBUG) log(Level.DEBUG, msg(), null) }
    fun trace(msg: () -> String) { if (level >= Level.TRACE) log(Level.TRACE, msg(), null) }

    private fun log(l: Level, msg: String, t: Throwable?) {
        if (l > level) return
        val line = buildString {
            append(LocalTime.now().format(time)).append(' ').append(l.name.padEnd(5)).append(' ')
            append('[').append(Thread.currentThread().name).append("] ").append(msg)
            if (t != null) {
                val sw = StringWriter(); t.printStackTrace(PrintWriter(sw)); append('\n').append(sw)
            }
        }
        System.err.println(line)
        file?.println(line)
        if (l <= Level.WARN) consoleSink?.invoke("[kotlin-debug] ${l.name}: $msg${t?.let { " ($it)" } ?: ""}\n")
    }
}
