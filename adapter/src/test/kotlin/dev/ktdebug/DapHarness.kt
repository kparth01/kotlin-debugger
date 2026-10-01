package dev.ktdebug

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** Minimal DAP client speaking the raw wire protocol (Content-Length framed JSON) like VS Code. */
class DapClient(private val process: Process) : AutoCloseable {
    private val gson = Gson()
    private val input = BufferedInputStream(process.inputStream)
    private var seq = 1
    private val responses = ConcurrentHashMap<Int, CompletableFuture<JsonObject>>()
    private val lock = Object()
    private val pendingEvents = mutableListOf<JsonObject>()
    val allEvents = java.util.concurrent.CopyOnWriteArrayList<JsonObject>()

    init {
        Thread({ readLoop() }, "test-dap-reader").apply { isDaemon = true }.start()
    }

    private fun readLoop() {
        try {
            while (true) {
                var length = -1
                while (true) {
                    val line = readHeaderLine() ?: return
                    if (line.isEmpty()) break
                    if (line.startsWith("Content-Length:")) length = line.substringAfter(':').trim().toInt()
                }
                val body = ByteArray(length)
                var off = 0
                while (off < length) {
                    val n = input.read(body, off, length - off)
                    if (n < 0) return
                    off += n
                }
                val msg = JsonParser.parseString(String(body, Charsets.UTF_8)).asJsonObject
                when (msg["type"].asString) {
                    "response" -> responses.remove(msg["request_seq"].asInt)?.complete(msg)
                    "event" -> {
                        allEvents += msg
                        synchronized(lock) { pendingEvents += msg; lock.notifyAll() }
                    }
                    "request" -> {
                        // reverse requests (runInTerminal) are not used by this adapter
                    }
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun readHeaderLine(): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return null
            if (b == '\n'.code) return buf.toString(Charsets.US_ASCII).trimEnd('\r')
            buf.write(b)
        }
    }

    fun requestRaw(command: String, args: Any? = null, timeoutSec: Long = 60): JsonObject {
        val id: Int
        val future = CompletableFuture<JsonObject>()
        synchronized(this) {
            id = seq++
            responses[id] = future
            val msg = JsonObject().apply {
                addProperty("seq", id)
                addProperty("type", "request")
                addProperty("command", command)
                if (args != null) add("arguments", gson.toJsonTree(args))
            }
            val bytes = gson.toJson(msg).toByteArray(Charsets.UTF_8)
            process.outputStream.write("Content-Length: ${bytes.size}\r\n\r\n".toByteArray(Charsets.US_ASCII))
            process.outputStream.write(bytes)
            process.outputStream.flush()
        }
        return future.get(timeoutSec, TimeUnit.SECONDS)
    }

    fun request(command: String, args: Any? = null, timeoutSec: Long = 60): JsonObject {
        val r = requestRaw(command, args, timeoutSec)
        check(r["success"].asBoolean) { "DAP '$command' failed: ${r["message"]} ${r["body"]}" }
        return r["body"]?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
    }

    fun waitEvent(name: String, timeoutMs: Long = 30_000, predicate: (JsonObject) -> Boolean = { true }): JsonObject {
        val deadline = System.currentTimeMillis() + timeoutMs
        synchronized(lock) {
            while (true) {
                val idx = pendingEvents.indexOfFirst { it["event"].asString == name && predicate(it["body"]?.asJsonObject ?: JsonObject()) }
                if (idx >= 0) return pendingEvents.removeAt(idx)
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) error("Timed out waiting for '$name' event. Events so far: ${allEvents.map { it["event"].asString + ":" + it["body"] }.takeLast(15)}")
                lock.wait(left)
            }
        }
    }

    fun hasEvent(name: String, predicate: (JsonObject) -> Boolean = { true }) =
        allEvents.any { it["event"].asString == name && predicate(it["body"]?.asJsonObject ?: JsonObject()) }

    override fun close() {
        runCatching { process.outputStream.close() }
        if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly()
    }
}

object Fixtures {
    val sources: Path = Paths.get(System.getProperty("fixture.sources") ?: "src/fixtures/kotlin").toAbsolutePath()
    private val classes = System.getProperty("fixture.classes") ?: "target/fixture-classes"
    private val deps = System.getProperty("fixture.classpath") ?: ""
    val java: String = File(System.getProperty("java.home"), "bin/java").path

    fun file(relative: String): Path = sources.resolve(relative)

    /** 1-based line of the `// @bp:<marker>` comment. */
    fun line(relative: String, marker: String): Int = line(sources, relative, marker)

    fun line(root: Path, relative: String, marker: String): Int {
        val lines = Files.readAllLines(root.resolve(relative))
        val idx = lines.indexOfFirst { it.contains("// @bp:$marker") && it.substringAfter("// @bp:$marker").let { r -> r.isEmpty() || !r[0].isLetterOrDigit() && r[0] != '-' } }
        check(idx >= 0) { "marker $marker not found in $relative" }
        return idx + 1
    }

    fun classpath() = listOf(classes, deps).filter { it.isNotBlank() }.joinToString(File.pathSeparator)
}

/** A JVM started independently of the debugger with a JDWP agent on an ephemeral port. */
class Debuggee(command: List<String>, val waitFor: Regex? = null, env: Map<String, String> = emptyMap()) : AutoCloseable {
    val process: Process
    val port: Int
    val stdout = StringBuffer()
    private val ready = CompletableFuture<Unit>()

    constructor(scenario: String, suspend: Boolean = true, extraJvmArgs: List<String> = emptyList()) : this(
        listOf(Fixtures.java) + extraJvmArgs + listOf(jdwp(suspend), "-cp", Fixtures.classpath(), "fixture.AppKt", scenario)
    )

    init {
        process = ProcessBuilder(command).redirectErrorStream(true).apply { environment().putAll(env) }.start()
        val portFuture = CompletableFuture<Int>()
        val re = Regex("Listening for transport dt_socket at address: (\\d+)")
        Thread({
            process.inputStream.bufferedReader().forEachLine { line ->
                stdout.append(line).append('\n')
                re.find(line)?.let { portFuture.complete(it.groupValues[1].toInt()) }
                if (waitFor != null && waitFor.containsMatchIn(line)) ready.complete(Unit)
            }
        }, "debuggee-out").apply { isDaemon = true }.start()
        port = portFuture.get(30, TimeUnit.SECONDS)
    }

    /** Waits until the [waitFor] pattern appears in the output (e.g. "Started DemoApplication"). */
    fun awaitReady(timeoutSec: Long = 60) {
        try {
            ready.get(timeoutSec, TimeUnit.SECONDS)
        } catch (e: Exception) {
            error("Debuggee not ready: $e\n$stdout")
        }
    }

    override fun close() {
        process.destroy()
        if (!process.waitFor(10, TimeUnit.SECONDS)) process.destroyForcibly()
    }

    companion object {
        fun jdwp(suspend: Boolean) = "-agentlib:jdwp=transport=dt_socket,server=y,suspend=${if (suspend) "y" else "n"},address=127.0.0.1:0"
    }
}

/** Convenience wrapper: adapter process + DAP client + debuggee, with typed helpers. */
class DebugRun(
    val debuggee: Debuggee,
    val testName: String,
    private val sourceRoot: java.nio.file.Path = Fixtures.sources,
) : AutoCloseable {
    constructor(scenario: String, suspend: Boolean = true, testName: String = scenario) : this(Debuggee(scenario, suspend), testName)

    private val adapter: Process
    val dap: DapClient
    val logFile: File = File("target/adapter-logs/$testName.log").also { it.parentFile.mkdirs() }

    init {
        val cp = System.getProperty("java.class.path")
        adapter = ProcessBuilder(Fixtures.java, "-cp", cp, "dev.ktdebug.MainKt", "--log-level", System.getProperty("adapter.logLevel", "DEBUG"))
            .redirectError(logFile)
            .start()
        dap = DapClient(adapter)
        dap.request("initialize", mapOf("adapterID" to "kotlin-jvm", "linesStartAt1" to true, "columnsStartAt1" to true, "pathFormat" to "path"))
    }

    fun attach(extra: Map<String, Any?> = emptyMap()) {
        val args = mapOf(
            "hostName" to "127.0.0.1", "port" to debuggee.port, "timeout" to 20_000,
            "projectRoot" to sourceRoot.toString(),
        ) + extra
        val f = CompletableFuture.supplyAsync { dap.request("attach", args) }
        dap.waitEvent("initialized")
        f.get(30, TimeUnit.SECONDS)
    }

    fun setBreakpoints(file: String, vararg bps: Map<String, Any?>): JsonArray =
        dap.request("setBreakpoints", mapOf(
            "source" to mapOf("path" to sourceRoot.resolve(file).toString(), "name" to file.substringAfterLast('/')),
            "breakpoints" to bps.toList(),
        ))["breakpoints"].asJsonArray

    fun line(file: String, marker: String) = Fixtures.line(sourceRoot, file, marker)

    fun bp(file: String, marker: String, condition: String? = null, hitCondition: String? = null, logMessage: String? = null) =
        mapOf("line" to line(file, marker), "condition" to condition, "hitCondition" to hitCondition, "logMessage" to logMessage)
            .filterValues { it != null }

    fun exceptionFilters(vararg filters: String) = dap.request("setExceptionBreakpoints", mapOf("filters" to filters.toList()))

    fun configurationDone() = dap.request("configurationDone")

    fun waitStopped(reason: String? = null, timeoutMs: Long = 30_000): JsonObject =
        dap.waitEvent("stopped", timeoutMs) { reason == null || it["reason"]?.asString == reason }["body"].asJsonObject

    fun stack(threadId: Int): List<JsonObject> =
        dap.request("stackTrace", mapOf("threadId" to threadId, "startFrame" to 0, "levels" to 200))["stackFrames"].asJsonArray.map { it.asJsonObject }

    fun top(threadId: Int) = stack(threadId).first()

    fun variables(ref: Int): List<JsonObject> =
        dap.request("variables", mapOf("variablesReference" to ref))["variables"].asJsonArray.map { it.asJsonObject }

    fun locals(frameId: Int): Map<String, JsonObject> {
        val scope = dap.request("scopes", mapOf("frameId" to frameId))["scopes"].asJsonArray.first().asJsonObject
        return variables(scope["variablesReference"].asInt).associateBy { it["name"].asString }
    }

    fun evaluate(expr: String, frameId: Int, context: String = "watch"): JsonObject =
        dap.request("evaluate", mapOf("expression" to expr, "frameId" to frameId, "context" to context))

    fun evaluateRaw(expr: String, frameId: Int): JsonObject =
        dap.requestRaw("evaluate", mapOf("expression" to expr, "frameId" to frameId, "context" to "watch"))

    fun next(threadId: Int) = dap.request("next", mapOf("threadId" to threadId))
    fun stepIn(threadId: Int) = dap.request("stepIn", mapOf("threadId" to threadId))
    fun stepOut(threadId: Int) = dap.request("stepOut", mapOf("threadId" to threadId))
    fun cont(threadId: Int) = dap.request("continue", mapOf("threadId" to threadId))

    fun waitTerminated(timeoutMs: Long = 30_000) = dap.waitEvent("terminated", timeoutMs)

    fun outputText(): String = dap.allEvents.filter { it["event"].asString == "output" }
        .joinToString("") { it["body"].asJsonObject["output"].asString }

    override fun close() {
        runCatching { dap.requestRaw("disconnect", mapOf("terminateDebuggee" to false), 10) }
        dap.close()
        debuggee.close()
        adapter.destroy()
    }
}

fun JsonObject.str(k: String): String? = this[k]?.takeIf { !it.isJsonNull }?.asString
fun JsonObject.int(k: String): Int? = this[k]?.takeIf { !it.isJsonNull }?.asInt
fun JsonElement.obj(): JsonObject = asJsonObject
