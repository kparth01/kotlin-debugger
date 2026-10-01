package dev.ktdebug

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInfo
import org.junit.jupiter.api.Timeout
import java.net.ServerSocket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Realistic validation: a Spring Boot 3 / Kotlin / coroutines app running as `java -jar` on
 * JDK 21 with a JDWP agent, the debugger attaching to it, and real HTTP traffic driving the code.
 * Requires `samples/spring-boot-kotlin-demo` to be built (`mvn package` there); skipped otherwise.
 */
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class SpringBootDebugTest {
    private val home: Path = Paths.get(System.getProperty("demo.home") ?: "../samples/spring-boot-kotlin-demo").toAbsolutePath().normalize()
    private val jar: Path = home.resolve("target/spring-boot-kotlin-demo.jar")
    private val src = "src/main/kotlin/com/example/demo"
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

    @BeforeEach
    fun requireDemo() = assumeTrue(Files.isRegularFile(jar), "Spring Boot demo not built: $jar")

    private fun freePort() = ServerSocket(0).use { it.localPort }

    private fun app(info: TestInfo, vararg extraArgs: String, body: (DebugRun, Int) -> Unit) {
        val httpPort = freePort()
        val cmd = listOf(Fixtures.java, Debuggee.jdwp(suspend = false), "-jar", jar.toString(), "--server.port=$httpPort") + extraArgs
        val debuggee = Debuggee(cmd, waitFor = Regex("Started DemoApplicationKt"))
        debuggee.awaitReady(90)
        DebugRun(debuggee, "spring-" + info.testMethod.get().name.replace(Regex("[^A-Za-z0-9]+"), "-"), home).use { r ->
            body(r, httpPort)
        }
    }

    private fun send(port: Int, method: String, path: String, json: String? = null): CompletableFuture<HttpResponse<String>> {
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path")).timeout(Duration.ofSeconds(120))
        if (json != null) b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(json))
        else b.method(method, HttpRequest.BodyPublishers.noBody())
        return http.sendAsync(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    private val orderJson = """{"customerId":"vip-42","lines":[{"productId":"apple","quantity":4,"unitPrice":0.5},{"productId":"melon","quantity":2,"unitPrice":3.2}]}"""

    @Test
    fun `controller to service through CGLIB proxy, inline helper and extension functions`(info: TestInfo) = app(info) { r, port ->
        val controller = "$src/web/OrderController.kt"
        val service = "$src/service/OrderService.kt"
        val pricing = "$src/service/PricingService.kt"
        val support = "$src/support/Instrumentation.kt"
        r.attach()
        val bps = r.setBreakpoints(controller, r.bp(controller, "controller-create"))
        assertTrue(bps[0].obj()["verified"].asBoolean, "Spring beans are loaded: breakpoint binds immediately: $bps")
        r.setBreakpoints(service, r.bp(service, "place-draft"))
        r.setBreakpoints(support, r.bp(support, "timed-body"))
        r.setBreakpoints(pricing, r.bp(pricing, "price-subtotal"))
        r.configurationDone()

        val response = send(port, "POST", "/orders", orderJson)

        // 1. controller
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        val top = r.top(tid)
        assertEquals("OrderController.create", top.str("name"))
        assertTrue(top["source"].obj().str("path")!!.endsWith("web/OrderController.kt"))
        val fid = top.int("id")!!
        assertEquals("\"vip-42\"", r.evaluate("request.customerId", fid).str("result"))
        assertEquals("2", r.evaluate("request.lines.size", fid).str("result"))
        assertEquals("\"melon\"", r.evaluate("request.lines[1].productId", fid).str("result"))
        assertTrue(r.locals(fid)["request"]!!.str("value")!!.startsWith("OrderRequest(customerId=vip-42"))

        // 2. step into: skips the CGLIB proxy and Spring AOP plumbing, lands in user code
        val visited = mutableListOf<String>()
        repeat(6) {
            if (visited.lastOrNull() == "OrderService.placeOrder") return@repeat
            r.stepIn(tid)
            r.waitStopped()
            visited += r.top(tid).str("name")!!
        }
        assertTrue("OrderService.placeOrder" in visited, "stepped into service through proxy: $visited")
        assertTrue(visited.none { it.contains("CGLIB") || it.startsWith("Cglib") || it.contains("ReflectiveMethodInvocation") }, "no framework frames: $visited")

        // 3. breakpoint in proxied service; meaningful call stack across Spring
        r.cont(tid)
        r.waitStopped("breakpoint")
        val stack = r.stack(tid).map { it.str("name")!! }
        assertEquals("OrderService.placeOrder", stack[0])
        assertTrue(stack.any { it == "OrderService.placeOrder (Spring proxy)" }, "proxy frame shown: ${stack.take(15)}")
        assertTrue(stack.any { it == "AuditAspect.audit" }, "aspect frame: ${stack.take(15)}")
        assertTrue(stack.any { it == "OrderController.create" }, "controller frame: ${stack.take(25)}")

        // 4. inline helper from another package inlined into PricingService.price
        r.cont(tid)
        r.waitStopped("breakpoint")
        val inl = r.stack(tid)
        assertEquals("timed (inlined)", inl[0].str("name"))
        assertTrue(inl[0]["source"].obj().str("path")!!.endsWith("support/Instrumentation.kt"))
        assertEquals("PricingService.price", inl[1].str("name"))
        assertTrue(inl[1]["source"].obj().str("path")!!.endsWith("service/PricingService.kt"))
        assertEquals("\"price\"", r.locals(inl[0].int("id")!!)["name"]!!.str("value"))

        // 5. inside the inline lambda: extension property/function evaluation, companion constant
        r.cont(tid)
        r.waitStopped("breakpoint")
        val p = r.top(tid)
        assertEquals(r.line(pricing, "price-subtotal"), p.int("line"))
        val pf = p.int("id")!!
        assertEquals("6", r.evaluate("order.itemCount", pf).str("result"))
        assertEquals("8.4", r.evaluate("order.subtotal()", pf).str("result"))
        assertEquals("10", r.evaluate("BULK_THRESHOLD", pf).str("result"))
        assertEquals("NEW", r.evaluate("order.status", pf).str("result")!!.substringAfter('.'))

        // 6. let the request finish
        r.setBreakpoints(controller); r.setBreakpoints(service); r.setBreakpoints(support); r.setBreakpoints(pricing)
        r.cont(tid)
        val res = response.get(30, TimeUnit.SECONDS)
        assertEquals(201, res.statusCode(), res.body())
        assertTrue(res.body().contains("\"total\":3.40"), res.body())
    }

    @Test
    fun `suspend endpoint - conditional breakpoint after delay and coroutine async stack`(info: TestInfo) = app(info) { r, port ->
        val catalog = "$src/service/CatalogClient.kt"
        r.attach()
        r.setBreakpoints(catalog, r.bp(catalog, "catalog-price", condition = "productId == \"pear\""))
        r.configurationDone()
        val response = send(port, "GET", "/orders/quote?ids=apple,pear,melon")

        val stop = r.waitStopped("breakpoint")
        val tid = stop.int("threadId")!!
        val frames = r.stack(tid)
        assertEquals("CatalogClient.price", frames[0].str("name"))
        assertEquals("\"pear\"", r.locals(frames[0].int("id")!!)["productId"]!!.str("value"))
        val names = frames.map { it.str("name")!! }
        val label = names.indexOf("Coroutine async stack (suspended callers)")
        assertTrue(label > 0, "async stack present: $names")
        val asyncPart = names.drop(label)
        assertTrue(asyncPart.any { it.startsWith("OrderService.quote") }, "service coroutine in async stack: $asyncPart")

        r.next(tid)
        val s2 = r.waitStopped("step")
        val after = r.top(s2.int("threadId")!!)
        assertEquals(r.line(catalog, "catalog-price") + 1, after.int("line"))
        assertEquals("\"0.75\"", r.locals(after.int("id")!!)["raw"]!!.str("value"))

        r.setBreakpoints(catalog)
        r.cont(s2.int("threadId")!!)
        val res = response.get(30, TimeUnit.SECONDS)
        assertEquals(200, res.statusCode())
        assertTrue(res.body().contains("\"pear\":0.75"), res.body())
    }

    @Test
    fun `exception thrown in service is caught by Spring and reported from application code`(info: TestInfo) = app(info) { r, port ->
        r.attach()
        r.exceptionFilters("userCaught")
        r.configurationDone()
        val response = send(port, "GET", "/orders/424242")
        val stop = r.waitStopped("exception")
        val tid = stop.int("threadId")!!
        assertTrue(stop.str("description")!!.contains("OrderNotFoundException"), stop.toString())
        val top = r.top(tid)
        assertEquals("OrderService.findOrder", top.str("name"))
        assertEquals(r.line("$src/service/OrderService.kt", "find-throw"), top.int("line"))
        val exInfo = r.dap.request("exceptionInfo", mapOf("threadId" to tid))
        assertEquals("Order 424242 not found", exInfo["details"].obj().str("message"))
        assertEquals("424242", r.evaluate("id", top.int("id")!!).str("result"))
        r.exceptionFilters()
        r.cont(tid)
        assertEquals(404, response.get(30, TimeUnit.SECONDS).statusCode())
    }

    @Test
    fun `launch the Spring Boot app with a Maven-resolved classpath`() {
        val log = java.io.File("target/adapter-logs/spring-launch.log").also { it.parentFile.mkdirs() }
        val proc = ProcessBuilder(Fixtures.java, "-cp", System.getProperty("java.class.path"), "dev.ktdebug.MainKt", "--log-level", "DEBUG")
            .redirectError(log).start()
        val dap = DapClient(proc)
        try {
            dap.request("initialize", mapOf("adapterID" to "kotlin-jvm"))
            val port = freePort()
            val launched = CompletableFuture.supplyAsync {
                dap.request("launch", mapOf(
                    "mainClass" to "com.example.demo.DemoApplicationKt",
                    "projectRoot" to home.toString(),
                    "args" to listOf("--server.port=$port"),
                    "vmArgs" to "-Xmx256m",
                ), 300)
            }
            dap.waitEvent("initialized", 300_000)
            launched.get(300, TimeUnit.SECONDS)
            val controller = "$src/web/OrderController.kt"
            dap.request("setBreakpoints", mapOf(
                "source" to mapOf("path" to home.resolve(controller).toString()),
                "breakpoints" to listOf(mapOf("line" to Fixtures.line(home, controller, "controller-get"))),
            ))
            dap.request("configurationDone")
            dap.waitEvent("output", 120_000) { it.str("output")?.contains("Started DemoApplicationKt") == true }
            val pending = send(port, "GET", "/orders/1")
            val stop = dap.waitEvent("stopped")["body"].obj()
            val top = dap.request("stackTrace", mapOf("threadId" to stop.int("threadId")))["stackFrames"].asJsonArray[0].obj()
            assertEquals("OrderController.get", top.str("name"))
            dap.request("continue", mapOf("threadId" to stop.int("threadId")))
            assertEquals(404, pending.get(30, TimeUnit.SECONDS).statusCode())
            dap.request("disconnect", mapOf("terminateDebuggee" to true))
            dap.waitEvent("terminated", 30_000)
        } finally {
            dap.close()
            proc.destroy()
        }
    }

    @Test
    fun `virtual threads (spring threads virtual enabled) - stop, inspect, step and detach`(info: TestInfo) =
        app(info, "--spring.threads.virtual.enabled=true") { r, port ->
            val controller = "$src/web/OrderController.kt"
            r.attach()
            r.setBreakpoints(controller, r.bp(controller, "controller-get", condition = "id == 7L"))
            r.configurationDone()

            // id 5 does not match the condition: no stop, plain 404
            assertEquals(404, send(port, "GET", "/orders/5").get(30, TimeUnit.SECONDS).statusCode())
            val pending = send(port, "GET", "/orders/7")
            val stop = r.waitStopped("breakpoint")
            val tid = stop.int("threadId")!!
            val threads = r.dap.request("threads")["threads"].asJsonArray.map { it.obj() }
            val t = threads.firstOrNull { it.int("id") == tid }
            assertTrue(t != null && t.str("name")!!.contains("(virtual)"), "stopped virtual thread is listed: $threads")
            val top = r.top(tid)
            assertEquals("OrderController.get", top.str("name"))
            assertEquals("7", r.locals(top.int("id")!!)["id"]!!.str("value"))

            // the user-written AuditAspect wraps the proxied call, so it is the first stop
            val visited = mutableListOf<String>()
            repeat(4) {
                if (visited.lastOrNull() == "OrderService.findOrder") return@repeat
                r.stepIn(tid)
                r.waitStopped("step")
                visited += r.top(tid).str("name")!!
            }
            assertEquals("AuditAspect.audit", visited.first(), "aspect advice is application code: $visited")
            assertEquals("OrderService.findOrder", visited.last(), "stepped into service on a virtual thread: $visited")

            // detach: the server must keep working without the debugger
            r.dap.request("disconnect", mapOf("terminateDebuggee" to false))
            assertEquals(404, pending.get(30, TimeUnit.SECONDS).statusCode())
            val revenue = send(port, "GET", "/orders/revenue").get(30, TimeUnit.SECONDS)
            assertEquals(200, revenue.statusCode())
            assertTrue(r.debuggee.process.isAlive)
        }
}
