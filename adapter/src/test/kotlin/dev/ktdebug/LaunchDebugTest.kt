package dev.ktdebug

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** `launch` request: the adapter starts the JVM itself (JDWP on an ephemeral port) and pipes its output. */
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class LaunchDebugTest {
    private fun adapter(name: String): Pair<Process, DapClient> {
        val log = File("target/adapter-logs/launch-$name.log").also { it.parentFile.mkdirs() }
        val p = ProcessBuilder(Fixtures.java, "-cp", System.getProperty("java.class.path"), "dev.ktdebug.MainKt", "--log-level", "DEBUG")
            .redirectError(log).start()
        val dap = DapClient(p)
        dap.request("initialize", mapOf("adapterID" to "kotlin-jvm", "linesStartAt1" to true))
        return p to dap
    }

    @Test
    fun `launch main class, stop at breakpoint, capture program output and terminate`() {
        val (proc, dap) = adapter("basic")
        try {
            val launched = CompletableFuture.supplyAsync {
                dap.request("launch", mapOf(
                    "mainClass" to "fixture.AppKt",
                    "args" to "basic",
                    "projectRoot" to Fixtures.sources.toString(),
                    "classPaths" to Fixtures.classpath().split(File.pathSeparator),
                ))
            }
            dap.waitEvent("initialized")
            launched.get(60, TimeUnit.SECONDS)
            val file = "fixture/Basic.kt"
            dap.request("setBreakpoints", mapOf(
                "source" to mapOf("path" to Fixtures.file(file).toString()),
                "breakpoints" to listOf(mapOf("line" to Fixtures.line(file, "apply-tax"))),
            ))
            dap.request("configurationDone")
            val stop = dap.waitEvent("stopped")["body"].obj()
            val tid = stop.int("threadId")!!
            val top = dap.request("stackTrace", mapOf("threadId" to tid))["stackFrames"].asJsonArray[0].obj()
            assertEquals("OrderService.applyTax", top.str("name"))
            dap.request("continue", mapOf("threadId" to tid))
            dap.waitEvent("terminated")
            val exited = dap.allEvents.firstOrNull { it.str("event") == "exited" }
            assertEquals(0, exited?.get("body")?.obj()?.int("exitCode"))
            val stdout = dap.allEvents.filter { it.str("event") == "output" && it["body"].obj().str("category") == "stdout" }
                .joinToString("") { it["body"].obj().str("output")!! }
            assertTrue(stdout.contains("order=Order(id=101"), stdout)
            assertFalse(stdout.contains("Listening for transport"), "JDWP banner is consumed by the adapter")
        } finally {
            runCatching { dap.requestRaw("disconnect", mapOf("terminateDebuggee" to true), 10) }
            dap.close()
            proc.destroy()
        }
    }

    @Test
    fun `attach failure gives an actionable error`() {
        val (proc, dap) = adapter("attach-fail")
        try {
            val port = java.net.ServerSocket(0).use { it.localPort } // nothing listens here
            val r = dap.requestRaw("attach", mapOf("hostName" to "127.0.0.1", "port" to port, "timeout" to 1500, "projectRoot" to Fixtures.sources.toString()))
            assertFalse(r["success"].asBoolean)
            val msg = r.str("message") ?: r["body"].obj()["error"].obj().str("format")
            assertTrue(msg!!.contains("-agentlib:jdwp") && msg.contains("$port"), msg)
        } finally {
            dap.close()
            proc.destroy()
        }
    }
}
