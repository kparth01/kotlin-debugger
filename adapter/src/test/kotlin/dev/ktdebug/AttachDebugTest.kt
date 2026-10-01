package dev.ktdebug

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInfo
import org.junit.jupiter.api.Timeout
import java.util.concurrent.TimeUnit

/**
 * End-to-end tests: DAP client -> adapter process (stdio) -> JDWP -> JVM 21 running Kotlin code.
 * Each debuggee is started independently with `-agentlib:jdwp=...` and the adapter *attaches*,
 * exactly like attaching VS Code to a remote Spring Boot JVM.
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class AttachDebugTest {

    private fun scenario(name: String, info: TestInfo, suspend: Boolean = true, body: (DebugRun) -> Unit) {
        DebugRun(name, suspend, info.testMethod.get().name.replace(Regex("[^A-Za-z0-9]+"), "-")).use(body)
    }

    private val basic = "fixture/Basic.kt"

    @Test
    fun `breakpoint in class method resolves and shows Kotlin variables`(info: TestInfo) = scenario("basic", info) { r ->
        r.attach()
        val bps = r.setBreakpoints(basic, r.bp(basic, "place-subtotal"))
        r.configurationDone()

        val stop = r.waitStopped("breakpoint")
        val tid = stop.int("threadId")!!
        assertEquals(bps[0].obj().int("id"), stop["hitBreakpointIds"].asJsonArray[0].asInt)
        val top = r.top(tid)
        assertEquals("OrderService.place", top.str("name"))
        assertEquals(Fixtures.line(basic, "place-subtotal"), top.int("line"))
        assertTrue(top["source"].obj().str("path")!!.endsWith("fixture/Basic.kt"))

        val locals = r.locals(top.int("id")!!)
        assertTrue(locals.keys.containsAll(listOf("this", "customer", "amounts")), "locals: ${locals.keys}")
        assertTrue(locals["customer"]!!.str("value")!!.contains("Customer(id=7, name=Ada"), "data class toString: ${locals["customer"]}")
        assertEquals("ArrayList(size=3)", locals["amounts"]!!.str("value").let { if (it!!.startsWith("Arrays")) "ArrayList(size=3)" else it })

        val fields = r.variables(locals["customer"]!!.int("variablesReference")!!).associateBy { it.str("name") }
        assertEquals("\"Ada\"", fields["name"]!!.str("value"))
        assertEquals("7", fields["id"]!!.str("value"))

        val fid = top.int("id")!!
        assertEquals("\"Ada\"", r.evaluate("customer.name", fid).str("result"))
        assertEquals("3", r.evaluate("amounts.size", fid).str("result"))
        assertEquals("\"beta\"", r.evaluate("customer.tags[1]", fid).str("result"))
        assertEquals("0.5", r.evaluate("taxRate * 2", fid).str("result"))
        assertEquals("true", r.evaluate("customer.name.startsWith(\"A\") && amounts[0] == 10", fid).str("result"))
        assertEquals("\"Ada has 2 tags\"", r.evaluate("\"\${customer.name} has \${customer.tags.size} tags\"", fid).str("result"))
        assertEquals("\"vip\"", r.evaluate("customer.tags.first()", fid).str("result"))
        assertEquals("true", r.evaluate("customer is Customer", fid).str("result"))
        assertEquals("true", r.evaluate("\"beta\" in customer.tags", fid).str("result"))
        assertFalse(r.evaluateRaw("doesNotExist + 1", fid)["success"].asBoolean)

        r.cont(tid)
        r.waitTerminated()
        assertTrue(r.debuggee.stdout.contains("order=Order("), r.debuggee.stdout.toString())
    }

    @Test
    fun `step over, into and out`(info: TestInfo) = scenario("basic", info) { r ->
        r.attach()
        r.setBreakpoints(basic, r.bp(basic, "place-subtotal"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!

        r.next(tid)
        r.waitStopped("step")
        assertEquals(Fixtures.line(basic, "place-total"), r.top(tid).int("line"))

        r.stepIn(tid)
        r.waitStopped("step")
        val inside = r.top(tid)
        assertEquals("OrderService.applyTax", inside.str("name"))
        assertEquals(Fixtures.line(basic, "apply-tax"), inside.int("line"))
        assertEquals("60", r.locals(inside.int("id")!!)["amount"]!!.str("value"))

        r.stepOut(tid)
        r.waitStopped("step")
        assertEquals("OrderService.place", r.top(tid).str("name"))

        r.cont(tid)
        r.waitTerminated()
    }

    @Test
    fun `top-level function and companion object breakpoints`(info: TestInfo) = scenario("basic", info) { r ->
        r.attach()
        r.setBreakpoints(basic, r.bp(basic, "basic-call"), r.bp(basic, "companion"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        val first = r.top(tid)
        assertEquals("BasicKt.basic", first.str("name"))
        assertEquals(Fixtures.line(basic, "basic-call"), first.int("line"))
        r.cont(tid)

        r.waitStopped("breakpoint")
        val comp = r.top(tid)
        assertEquals("OrderService.Companion.nextId", comp.str("name"))
        assertEquals(Fixtures.line(basic, "companion"), comp.int("line"))
        // call stack is meaningful: companion <- place <- basic <- main
        val names = r.stack(tid).map { it.str("name") }
        assertEquals(listOf("OrderService.Companion.nextId", "OrderService.place", "BasicKt.basic", "AppKt.main"), names.take(4))
        r.cont(tid)
        r.waitTerminated()
    }

    @Test
    fun `breakpoint inside inline function from another file and package`(info: TestInfo) = scenario("inline", info) { r ->
        r.attach()
        val bps = r.setBreakpoints("fixture/util/Timing.kt", r.bp("fixture/util/Timing.kt", "inline-body"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        val stack = r.stack(tid)
        // virtual frame for the inline function, real frame at the call site
        assertEquals("measured (inlined)", stack[0].str("name"))
        assertTrue(stack[0]["source"].obj().str("path")!!.endsWith("fixture/util/Timing.kt"))
        assertEquals(Fixtures.line("fixture/util/Timing.kt", "inline-body"), stack[0].int("line"))
        assertEquals("InlineKt.inlineScenario", stack[1].str("name"))
        assertTrue(stack[1]["source"].obj().str("path")!!.endsWith("fixture/Inline.kt"))
        assertEquals(Fixtures.line("fixture/Inline.kt", "inline-call"), stack[1].int("line"))

        val inlineVars = r.locals(stack[0].int("id")!!)
        assertTrue(inlineVars.keys.containsAll(listOf("label", "start")), "inline locals: ${inlineVars.keys}")
        assertEquals("\"sum\"", inlineVars["label"]!!.str("value"))
        val callerVars = r.locals(stack[1].int("id")!!)
        assertTrue("numbers" in callerVars.keys && "label" !in callerVars.keys, "caller locals: ${callerVars.keys}")
        assertEquals("\"sum\"", r.evaluate("label", stack[0].int("id")!!).str("result"))
        assertNotNull(bps)
        r.cont(tid)
        r.waitTerminated()
    }

    @Test
    fun `call-site breakpoint on inline call stops once and step over skips the inline body`(info: TestInfo) = scenario("inline", info) { r ->
        r.attach()
        r.setBreakpoints("fixture/Inline.kt", r.bp("fixture/Inline.kt", "inline-call"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        assertEquals(Fixtures.line("fixture/Inline.kt", "inline-call"), r.top(tid).int("line"))

        r.next(tid)
        r.waitStopped("step")
        val afterStep = r.top(tid)
        assertTrue(afterStep["source"].obj().str("path")!!.endsWith("fixture/Inline.kt"), "step over must not enter Timing.kt: $afterStep")
        assertEquals(Fixtures.line("fixture/Inline.kt", "inline-lambda"), afterStep.int("line"))

        r.cont(tid)
        // the call-site line has a second line-table entry after the inlined body; it must not re-trigger
        r.waitTerminated()
        assertFalse(r.dap.allEvents.count { it.str("event") == "stopped" } > 2)
    }

    @Test
    fun `lambdas, SAM conversions, anonymous objects and extension functions`(info: TestInfo) = scenario("lambdas", info) { r ->
        val f = "fixture/Lambdas.kt"
        r.attach()
        r.setBreakpoints(f, r.bp(f, "comparator"), r.bp(f, "anonymous"), r.bp(f, "retry-lambda"), r.bp(f, "extension"))
        r.configurationDone()

        val tid = r.waitStopped("breakpoint").int("threadId")!!
        val cmp = r.top(tid)
        assertEquals(Fixtures.line(f, "comparator"), cmp.int("line"))
        assertTrue(cmp.str("name")!!.contains("lambda"), cmp.str("name"))
        assertTrue(r.locals(cmp.int("id")!!).keys.containsAll(listOf("a", "b")))
        // the comparator runs several times while sorting: remove its breakpoint before continuing
        r.setBreakpoints(f, r.bp(f, "anonymous"), r.bp(f, "retry-lambda"), r.bp(f, "extension"))
        r.cont(tid)

        r.waitStopped("breakpoint")
        val anon = r.top(tid)
        assertEquals(Fixtures.line(f, "anonymous"), anon.int("line"))
        assertTrue(anon.str("name")!!.endsWith(".run"), anon.str("name"))
        assertEquals("\"item\"", r.evaluate("prefix", anon.int("id")!!).str("result"))  // captured variable
        r.cont(tid)

        r.waitStopped("breakpoint")
        val retry = r.top(tid)
        assertEquals(Fixtures.line(f, "retry-lambda"), retry.int("line"))
        val vars = r.locals(retry.int("id")!!)
        assertEquals("1", vars["attempt"]!!.str("value"))
        assertEquals("\"item\"", vars["prefix"]!!.str("value"))
        assertTrue(r.stack(tid).any { it.str("name") == "TimingKt.retry" }, "retry frame in stack")
        r.cont(tid)

        r.waitStopped("breakpoint")
        val ext = r.top(tid)
        assertEquals(Fixtures.line(f, "extension"), ext.int("line"))
        assertEquals("\"hey\"", r.locals(ext.int("id")!!)["this@shout"]!!.str("value"))
        assertEquals("2", r.evaluate("times", ext.int("id")!!).str("result"))
        assertEquals("3", r.evaluate("length", ext.int("id")!!).str("result")) // implicit extension receiver
        r.cont(tid)
        r.waitTerminated()
    }

    @Test
    fun `exception breakpoints for application code and uncaught exceptions`(info: TestInfo) = scenario("exceptions", info) { r ->
        r.attach()
        r.exceptionFilters("userCaught", "uncaught")
        r.configurationDone()
        val stop = r.waitStopped("exception")
        val tid = stop.int("threadId")!!
        assertTrue(stop.str("description")!!.contains("fixture.InsufficientFunds"), stop.toString())
        val top = r.top(tid)
        assertEquals("ExceptionsKt.withdraw", top.str("name"))
        assertEquals(Fixtures.line("fixture/Exceptions.kt", "throw"), top.int("line"))
        val info = r.dap.request("exceptionInfo", mapOf("threadId" to tid))
        assertEquals("fixture.InsufficientFunds", info.str("exceptionId"))
        assertEquals("need 40 more", info["details"].obj().str("message"))
        r.cont(tid)

        // second throw is not caught anywhere -> reported again (userCaught does not match, uncaught does)
        val second = r.waitStopped("exception")
        assertTrue(second.str("description")!!.startsWith("Uncaught"), second.toString())
        r.cont(tid)
        r.waitTerminated()
    }

    @Test
    fun `exception filter with class-name condition`(info: TestInfo) = scenario("exceptions", info) { r ->
        r.attach()
        // Only IllegalStateException (not thrown here) for caught exceptions; uncaught filtered to InsufficientFunds.
        r.dap.request("setExceptionBreakpoints", mapOf(
            "filters" to emptyList<String>(),
            "filterOptions" to listOf(
                mapOf("filterId" to "userCaught", "condition" to "IllegalStateException"),
                mapOf("filterId" to "uncaught", "condition" to "InsufficientFunds"),
            ),
        ))
        r.configurationDone()
        val stop = r.waitStopped("exception")
        assertTrue(stop.str("description")!!.startsWith("Uncaught fixture.InsufficientFunds"), stop.toString())
        r.cont(stop.int("threadId")!!)
        r.waitTerminated()
        assertEquals(1, r.dap.allEvents.count { it.str("event") == "stopped" }, "caught InsufficientFunds was filtered out")
    }

    @Test
    fun `coroutines - breakpoint after suspension, async stack and variables`(info: TestInfo) = scenario("coroutines", info) { r ->
        val f = "fixture/Coroutines.kt"
        r.attach()
        r.setBreakpoints(f, r.bp(f, "after-delay"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        val stack = r.stack(tid)
        assertEquals("CoroutinesKt.fetchPrice", stack[0].str("name"))
        assertEquals(Fixtures.line(f, "after-delay"), stack[0].int("line"))
        val vars = r.locals(stack[0].int("id")!!)
        assertEquals("\"apple\"", vars["item"]?.str("value"), "locals: $vars")
        // After `delay` the physical stack starts at the dispatcher; the logical callers come
        // from the continuation chain.
        val names = stack.map { it.str("name") }
        val label = names.indexOf("Coroutine async stack (suspended callers)")
        assertTrue(label > 0, "async stack label present: $names")
        assertTrue(names.drop(label).any { it == "CoroutinesKt.loadCart" }, "loadCart is an async caller: $names")
        val loadCart = stack.drop(label).first { it.str("name") == "CoroutinesKt.loadCart" }
        assertEquals(Fixtures.line(f, "suspend-call"), loadCart.int("line"))
        r.setBreakpoints(f) // clear
        r.next(tid)
        r.waitStopped("step")
        val afterStep = r.top(tid)
        assertEquals(Fixtures.line(f, "after-delay") + 1, afterStep.int("line"))
        assertEquals("50", r.locals(afterStep.int("id")!!)["price"]?.str("value"))
        r.cont(tid)
        r.waitTerminated()
        assertTrue(r.debuggee.stdout.contains("cart=90 banana=60"), r.debuggee.stdout.toString())
    }

    @Test
    fun `coroutines - step over a suspension point continues in the same coroutine`(info: TestInfo) = scenario("coroutines", info) { r ->
        val f = "fixture/Coroutines.kt"
        r.attach()
        r.setBreakpoints(f, r.bp(f, "suspend-call"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        assertEquals(Fixtures.line(f, "suspend-call"), r.top(tid).int("line"))
        r.setBreakpoints(f) // clear, so only the step can stop us

        r.next(tid)
        val stop = r.waitStopped("step")
        val t2 = stop.int("threadId")!!
        val top = r.top(t2)
        assertEquals("CoroutinesKt.loadCart", top.str("name"))
        assertEquals(Fixtures.line(f, "after-suspend"), top.int("line"))
        assertEquals("50", r.locals(top.int("id")!!)["p"]!!.str("value"))
        r.cont(t2)
        r.waitTerminated()
    }

    @Test
    fun `generics, sealed classes and evaluation`(info: TestInfo) = scenario("generics", info) { r ->
        val f = "fixture/Generics.kt"
        r.attach()
        r.setBreakpoints(f, r.bp(f, "generic-save"), r.bp(f, "generic-result"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        val save = r.top(tid)
        assertEquals("InMemoryRepository.save", save.str("name"))
        assertEquals("\"Grace\"", r.evaluate("(entity as Customer).name", save.int("id")!!).str("result"))
        assertEquals("0", r.evaluate("store.size", save.int("id")!!).str("result"))
        r.cont(tid)

        r.waitStopped("breakpoint")
        val res = r.top(tid)
        val fid = res.int("id")!!
        assertEquals("true", r.evaluate("outcome is Outcome.Ok", fid).str("result"))
        assertTrue(r.evaluate("outcome", fid).str("result")!!.startsWith("Ok(value=Customer(id=1"))
        assertEquals("\"Grace\"", r.evaluate("found?.name ?: \"none\"", fid).str("result"))
        r.cont(tid)
        r.waitTerminated()
    }

    @Test
    fun `conditional breakpoints, hit counts and logpoints`(info: TestInfo) = scenario("loop", info) { r ->
        val f = "fixture/Loop.kt"
        r.attach()
        r.setBreakpoints(f, r.bp(f, "loop-body", condition = "i == 7"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        val vars = r.locals(r.top(tid).int("id")!!)
        assertEquals("7", vars["i"]!!.str("value"))
        assertEquals("21", vars["acc"]!!.str("value"))
        // switch to a logpoint + hit-count breakpoint while stopped
        r.setBreakpoints(f, r.bp(f, "loop-body", logMessage = "i={i} acc={acc}"))
        r.cont(tid)
        r.waitTerminated()
        val out = r.outputText()
        assertTrue(out.contains("i=8 acc=28") && out.contains("i=10 acc=45"), out)
        assertFalse(out.contains("i=7 acc"), "logpoint was installed after i=7: $out")
    }

    @Test
    fun `hit condition stops on the nth hit`(info: TestInfo) = scenario("loop", info) { r ->
        val f = "fixture/Loop.kt"
        r.attach()
        r.setBreakpoints(f, r.bp(f, "loop-body", hitCondition = "4"))
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        assertEquals("4", r.locals(r.top(tid).int("id")!!)["i"]!!.str("value"))
        r.cont(tid)
        r.waitTerminated()
    }

    @Test
    fun `function breakpoint and setVariable`(info: TestInfo) = scenario("basic", info) { r ->
        r.attach()
        val fbp = r.dap.request("setFunctionBreakpoints", mapOf("breakpoints" to listOf(mapOf("name" to "OrderService.applyTax"))))
        assertNotNull(fbp["breakpoints"])
        r.configurationDone()
        val tid = r.waitStopped("breakpoint").int("threadId")!!
        val top = r.top(tid)
        assertEquals("OrderService.applyTax", top.str("name"))
        val scope = r.dap.request("scopes", mapOf("frameId" to top.int("id")!!))["scopes"].asJsonArray[0].obj()
        val set = r.dap.request("setVariable", mapOf("variablesReference" to scope.int("variablesReference"), "name" to "amount", "value" to "100"))
        assertEquals("100", set.str("value"))
        assertEquals("100", r.evaluate("amount", r.top(tid).int("id")!!).str("result"))
        r.cont(tid)
        r.waitTerminated()
        assertTrue(r.debuggee.stdout.contains("total=125.0"), r.debuggee.stdout.toString())
    }

    @Test
    fun `attach to an already running JVM, bind to loaded class, pause and detach`(info: TestInfo) = scenario("spin", info, suspend = false) { r ->
        Thread.sleep(1500) // let the app run so Ticker is already loaded when we attach
        r.attach()
        r.configurationDone()
        val threads = r.dap.request("threads")["threads"].asJsonArray.map { it.obj().str("name") }
        assertTrue("main" in threads, threads.toString())

        r.dap.request("pause", mapOf("threadId" to 1))
        val paused = r.waitStopped("pause")
        assertTrue(paused["allThreadsStopped"].asBoolean)
        val main = r.dap.request("threads")["threads"].asJsonArray.map { it.obj() }.first { it.str("name") == "main" }.int("id")!!
        assertTrue(r.stack(main).any { it.str("name") == "LoopKt.spin" })
        r.cont(main)

        val f = "fixture/Loop.kt"
        val bps = r.setBreakpoints(f, r.bp(f, "tick"))
        assertTrue(bps[0].obj()["verified"].asBoolean, "already-loaded class binds immediately: $bps")
        val stop = r.waitStopped("breakpoint")
        val top = r.top(stop.int("threadId")!!)
        assertEquals("Ticker.tick", top.str("name"))
        assertTrue(r.evaluate("ticks", top.int("id")!!).str("result")!!.toInt() > 0)

        // detach: the JVM must keep running without the debugger
        r.dap.request("disconnect", mapOf("terminateDebuggee" to false))
        Thread.sleep(500)
        assertTrue(r.debuggee.process.isAlive, "debuggee survives detach")
    }
}
