package dev.ktdebug

import dev.ktdebug.dap.KotlinDebugServer
import dev.ktdebug.util.Log
import org.eclipse.lsp4j.debug.launch.DSPLauncher
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import kotlin.system.exitProcess

/**
 * Entry point of the Kotlin debug adapter.
 *
 *   java -jar kotlin-debug-adapter.jar                  # DAP over stdin/stdout (used by VS Code)
 *   java -jar kotlin-debug-adapter.jar --port 4711      # DAP over TCP, one session per connection
 *   java -jar kotlin-debug-adapter.jar --log-file /tmp/kda.log --log-level DEBUG
 */
fun main(args: Array<String>) {
    var port: Int? = null
    var i = 0
    while (i < args.size) {
        when (args[i]) {
            "--port" -> port = args.getOrNull(++i)?.toIntOrNull()
            "--log-file" -> args.getOrNull(++i)?.let(Log::logToFile)
            "--log-level" -> args.getOrNull(++i)?.let { lvl ->
                runCatching { Log.level = Log.Level.valueOf(lvl.uppercase()) }
            }
            "--version" -> { println(VERSION); return }
        }
        i++
    }

    if (!jdiAvailable()) {
        System.err.println(
            "The Kotlin debug adapter needs a full JDK (module jdk.jdi), but it is running on " +
                "'${System.getProperty("java.home")}' which does not provide it. Point " +
                "'kotlinDebugger.javaHome' (or JAVA_HOME) at a JDK 17+ installation."
        )
        exitProcess(2)
    }

    Log.info("Kotlin debug adapter $VERSION starting on Java ${System.getProperty("java.version")} (${System.getProperty("java.home")})")

    if (port != null) {
        ServerSocket(port, 50, InetAddress.getLoopbackAddress()).use { server ->
            Log.info("Listening for DAP clients on port ${server.localPort}")
            while (true) {
                val socket = server.accept()
                Thread({ runSession(socket.getInputStream(), socket.getOutputStream()) }, "dap-session").start()
            }
        }
    } else {
        // Anything printed to System.out would corrupt the protocol stream.
        val protocolOut = System.out
        System.setOut(System.err)
        runSession(System.`in`, protocolOut)
        exitProcess(0)
    }
}

const val VERSION = "2.0.0"

private fun jdiAvailable(): Boolean =
    runCatching { Class.forName("com.sun.jdi.Bootstrap") }.isSuccess

fun runSession(input: InputStream, output: OutputStream) {
    val server = KotlinDebugServer()
    val launcher = DSPLauncher.createServerLauncher(
        server, input, output, Executors.newCachedThreadPool { r -> Thread(r, "dap-io").apply { isDaemon = true } }, null
    )
    server.connect(launcher.remoteProxy)
    val listening = launcher.startListening()
    try {
        listening.get()
    } catch (e: Exception) {
        Log.debug { "DAP connection closed: $e" }
    } finally {
        server.shutdown()
    }
}
