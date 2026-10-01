package dev.ktdebug.session

import com.sun.jdi.ClassType
import com.sun.jdi.IncompatibleThreadStateException
import com.sun.jdi.InterfaceType
import com.sun.jdi.InvocationException
import com.sun.jdi.Location
import com.sun.jdi.Method
import com.sun.jdi.ObjectCollectedException
import com.sun.jdi.ObjectReference
import com.sun.jdi.StringReference
import com.sun.jdi.ThreadReference
import com.sun.jdi.VMDisconnectedException
import com.sun.jdi.Value
import com.sun.jdi.VirtualMachine
import com.sun.jdi.event.BreakpointEvent
import com.sun.jdi.event.ClassPrepareEvent
import com.sun.jdi.event.Event
import com.sun.jdi.event.EventSet
import com.sun.jdi.event.ExceptionEvent
import com.sun.jdi.event.MethodExitEvent
import com.sun.jdi.event.StepEvent
import com.sun.jdi.event.ThreadDeathEvent
import com.sun.jdi.event.ThreadStartEvent
import com.sun.jdi.event.VMDeathEvent
import com.sun.jdi.event.VMDisconnectEvent
import com.sun.jdi.event.VMStartEvent
import com.sun.jdi.request.BreakpointRequest
import com.sun.jdi.request.EventRequest
import com.sun.jdi.request.MethodExitRequest
import com.sun.jdi.request.StepRequest
import dev.ktdebug.eval.EvalException
import dev.ktdebug.eval.Evaluator
import dev.ktdebug.jdi.Kotlin
import dev.ktdebug.jdi.StackBuilder
import dev.ktdebug.jdi.Values
import dev.ktdebug.util.HitCondition
import dev.ktdebug.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

enum class StepKind { OVER, INTO, OUT }

/** A frame handle: which thread / JDI depth, and how it is presented. */
data class FrameRef(
    val threadUid: Long,
    val threadId: Int,
    val depth: Int,
    val kind: Kind,
    val continuation: ObjectReference? = null,
) {
    enum class Kind { REAL, INLINE, ASYNC }
}

/**
 * One debugging session against one JVM, attached through JDWP. Owns the JDI event loop, the
 * suspend/resume bookkeeping for threads, stepping (including Kotlin inline functions and
 * coroutine suspension points) and the per-stop handle tables.
 */
class DebugSession(
    val vm: VirtualMachine,
    val config: SessionConfig,
    val sources: SourceIndex,
    val events: DebugEvents,
    val process: Process? = null,
) {
    val threadIds = ThreadIds()
    val frames = Handles<FrameRef>()
    val variables = Handles<Any>()
    val breakpoints = BreakpointManager(this)
    val values = Values(this)
    val stacks = StackBuilder(this)
    val evaluator = Evaluator(this)

    val breakpointSuspendPolicy: Int
        get() = if (config.suspendAllThreads) EventRequest.SUSPEND_ALL else EventRequest.SUSPEND_EVENT_THREAD

    private class Stop(
        val thread: ThreadReference,
        val eventSet: EventSet?,
        val reason: String,
        val description: String?,
        val exception: ObjectReference?,
        /** Temporary record while a breakpoint condition is evaluated (not a user-visible stop). */
        val probe: Boolean = false,
    )

    private val stops = ConcurrentHashMap<Long, Stop>()
    @Volatile var pausedAll = false
        private set
    private val pinned = ConcurrentHashMap<Long, MutableList<ObjectReference>>()
    val invokingThreads: MutableSet<Long> = ConcurrentHashMap.newKeySet()
    private val worker = Executors.newCachedThreadPool { r -> Thread(r, "kda-worker").apply { isDaemon = true } }
    private val watchdog = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "kda-watchdog").apply { isDaemon = true } }
    @Volatile private var startEventSet: EventSet? = null
    @Volatile private var configured = false
    @Volatile private var disposed = false
    @Volatile private var terminatedSent = false
    private val coroutineSteps = CopyOnWriteArrayList<StepContext>()

    // ====================================================================== lifecycle

    fun start() {
        val erm = vm.eventRequestManager()
        erm.createThreadStartRequest().apply {
            setSuspendPolicy(EventRequest.SUSPEND_NONE)
            platformThreadsOnly(this)
            enable()
        }
        erm.createThreadDeathRequest().apply {
            setSuspendPolicy(EventRequest.SUSPEND_NONE)
            platformThreadsOnly(this)
            enable()
        }
        Thread(::eventLoop, "kda-jdi-events").apply { isDaemon = true }.start()
    }

    /** JDK 21+: avoid an event per virtual thread (Spring Boot with virtual threads creates many). */
    private fun platformThreadsOnly(request: EventRequest) {
        runCatching { request.javaClass.getMethod("addPlatformThreadsOnly").invoke(request) }
    }

    /** DAP `configurationDone`: breakpoints are installed, release a VM that waits for us. */
    fun configurationDone() {
        configured = true
        startEventSet?.let { set ->
            startEventSet = null
            Log.info("Resuming VM that was waiting for the debugger (suspend=y)")
            set.resume()
        }
    }

    fun disconnect(terminateDebuggee: Boolean) {
        if (disposed) return
        try {
            if (terminateDebuggee) {
                Log.info("Terminating debuggee")
                runCatching { vm.exit(0) }
                process?.destroy()
            } else {
                runCatching { breakpoints.clearAll() }
                runCatching { resumeAll() }
                startEventSet?.let { runCatching { it.resume() } }
                vm.dispose()   // detaches, drops all requests and resumes all threads
            }
        } catch (e: VMDisconnectedException) {
            // already gone
        } finally {
            disposed = true
            worker.shutdownNow()
            watchdog.shutdownNow()
        }
    }

    private fun onDisconnected() {
        if (terminatedSent) return
        terminatedSent = true
        disposed = true
        process?.let { p ->
            runCatching { p.waitFor(2, TimeUnit.SECONDS) }
            if (!p.isAlive) events.exited(p.exitValue())
        }
        events.terminated()
    }

    // ====================================================================== event loop

    private sealed interface Outcome {
        object Resume : Outcome
        data class Stop(
            val reason: String,
            val description: String? = null,
            val text: String? = null,
            val hitIds: List<Int> = emptyList(),
            val exception: ObjectReference? = null,
        ) : Outcome
        class Deferred(val compute: () -> Outcome) : Outcome
        object Hold : Outcome
    }

    private fun eventLoop() {
        val queue = vm.eventQueue()
        while (!disposed) {
            val set = try {
                queue.remove()
            } catch (e: InterruptedException) {
                break
            } catch (e: VMDisconnectedException) {
                onDisconnected(); break
            }
            try {
                handleEventSet(set)
            } catch (e: VMDisconnectedException) {
                onDisconnected(); break
            } catch (e: Exception) {
                Log.error("Error while handling JDI events $set", e)
                runCatching { set.resume() }
            }
        }
    }

    private fun handleEventSet(set: EventSet) {
        Log.trace { "EventSet policy=${set.suspendPolicy()} ${set.joinToString { it.javaClass.simpleName }}" }
        val outcomes = set.map { ev -> ev to handleEvent(ev, set) }
        if (outcomes.any { it.second === Outcome.Hold }) return
        val thread = outcomes.firstNotNullOfOrNull { (ev, _) -> threadOf(ev) }
        val stops = outcomes.mapNotNull { it.second as? Outcome.Stop }
        if (stops.isNotEmpty() && thread != null) {
            reportStop(thread, set, merge(stops)); return
        }
        val deferred = outcomes.mapNotNull { it.second as? Outcome.Deferred }
        if (deferred.isNotEmpty() && thread != null) {
            worker.execute {
                try {
                    val results = deferred.map { d ->
                        try { d.compute() } catch (e: Exception) {
                            Log.warn("Breakpoint evaluation failed", e)
                            Outcome.Stop("breakpoint", description = "Breakpoint condition error: ${e.message}")
                        }
                    }
                    val s = results.filterIsInstance<Outcome.Stop>()
                    if (s.isNotEmpty()) reportStop(thread, set, merge(s)) else set.resume()
                } catch (e: VMDisconnectedException) {
                    onDisconnected()
                }
            }
            return
        }
        set.resume()
    }

    private fun merge(stops: List<Outcome.Stop>): Outcome.Stop =
        stops.first().copy(hitIds = stops.flatMap { it.hitIds }.distinct())

    private fun threadOf(ev: Event): ThreadReference? = when (ev) {
        is com.sun.jdi.event.LocatableEvent -> ev.thread()
        is ThreadStartEvent -> ev.thread()
        is ThreadDeathEvent -> ev.thread()
        is ClassPrepareEvent -> ev.thread()
        is VMStartEvent -> ev.thread()
        else -> null
    }

    private fun handleEvent(ev: Event, set: EventSet): Outcome = when (ev) {
        is VMStartEvent -> {
            if (set.suspendPolicy() != EventRequest.SUSPEND_NONE && !configured) {
                startEventSet = set
                Outcome.Hold
            } else Outcome.Resume
        }
        is ClassPrepareEvent -> { breakpoints.onClassPrepare(ev); Outcome.Resume }
        is BreakpointEvent -> onBreakpoint(ev)
        is StepEvent -> onStep(ev)
        is ExceptionEvent -> onException(ev)
        is MethodExitEvent -> onMethodExit(ev)
        is ThreadStartEvent -> { events.thread(threadIds.idOf(ev.thread()), true); Outcome.Resume }
        is ThreadDeathEvent -> {
            val t = ev.thread()
            events.thread(threadIds.idOf(t), false)
            stops.remove(t.uniqueID())
            threadIds.remove(t)
            Outcome.Resume
        }
        is VMDeathEvent -> Outcome.Resume
        is VMDisconnectEvent -> { onDisconnected(); Outcome.Resume }
        else -> Outcome.Resume
    }

    // ---------------------------------------------------------------- breakpoints

    private fun onBreakpoint(ev: BreakpointEvent): Outcome {
        val t = ev.thread()
        if (t.uniqueID() in invokingThreads) return Outcome.Resume // hit while evaluating an expression
        (ev.request().getProperty(RESUME_KEY) as? StepContext)?.let { return onCoroutineResume(ev, it) }
        val bp = ev.request().getProperty(BreakpointManager.BP_KEY) as? LineBreakpoint ?: return Outcome.Resume
        if (bp.condition.isNullOrBlank() && bp.hitCondition.isNullOrBlank() && bp.logMessage == null) {
            bp.hits.incrementAndGet()
            return Outcome.Stop("breakpoint", hitIds = listOf(bp.id))
        }
        return Outcome.Deferred { evaluateBreakpoint(t, bp) }
    }

    private fun evaluateBreakpoint(t: ThreadReference, bp: LineBreakpoint): Outcome {
        // Expressions may invoke methods, which requires the thread to count as "stopped by event".
        val probe = Stop(t, null, "condition", null, null, probe = true)
        stops.putIfAbsent(t.uniqueID(), probe)
        try {
            if (!bp.condition.isNullOrBlank()) {
                val ok = try {
                    evaluator.evaluateCondition(t, bp.condition)
                } catch (e: EvalException) {
                    return Outcome.Stop("breakpoint", description = "Error in breakpoint condition '${bp.condition}': ${e.message}", hitIds = listOf(bp.id))
                }
                if (!ok) return Outcome.Resume
            }
            val hits = bp.hits.incrementAndGet()
            if (!bp.hitCondition.isNullOrBlank() && !HitCondition.matches(bp.hitCondition, hits)) return Outcome.Resume
            if (bp.logMessage != null) {
                events.output(evaluator.interpolate(t, bp.logMessage) + "\n", "console")
                return Outcome.Resume
            }
            return Outcome.Stop("breakpoint", hitIds = listOf(bp.id))
        } finally {
            stops.remove(t.uniqueID(), probe)
            unpin(t.uniqueID())
        }
    }

    private fun onException(ev: ExceptionEvent): Outcome {
        val t = ev.thread()
        if (t.uniqueID() in invokingThreads) return Outcome.Resume
        val filter = ev.request().getProperty(BreakpointManager.EXC_FILTER_KEY) as? String
        val type = ev.exception().referenceType()
        val conditions = filter?.let { breakpoints.exceptionConditions[it] }.orEmpty()
        if (conditions.isNotEmpty() && conditions.none { c -> typeMatches(type, c) }) return Outcome.Resume
        val message = values.throwableMessage(ev.exception())
        val caught = if (ev.catchLocation() == null) "Uncaught" else "Caught"
        return Outcome.Stop(
            "exception",
            description = "$caught ${type.name()}" + (message?.let { ": $it" } ?: ""),
            text = type.name(),
            exception = ev.exception(),
        )
    }

    private fun typeMatches(type: com.sun.jdi.ReferenceType, name: String): Boolean {
        var t: ClassType? = type as? ClassType
        while (t != null) {
            if (t.name() == name || t.name().substringAfterLast('.') == name) return true
            t = t.superclass()
        }
        return false
    }

    // ---------------------------------------------------------------- stops & resume

    private fun reportStop(t: ThreadReference, set: EventSet, stop: Outcome.Stop) {
        cancelSteps(t)
        stops[t.uniqueID()] = Stop(t, set, stop.reason, stop.description, stop.exception)
        stop.exception?.let { pin(t.uniqueID(), it) }
        Log.debug { "Stopped thread ${t.name()} (${stop.reason}) at ${runCatching { t.frame(0).location() }.getOrNull()}" }
        events.stopped(
            threadIds.idOf(t), stop.reason, stop.description, stop.text, stop.hitIds,
            allThreadsStopped = set.suspendPolicy() == EventRequest.SUSPEND_ALL,
        )
    }

    fun isStoppedByEvent(t: ThreadReference): Boolean = stops[t.uniqueID()] != null

    fun stopDescription(t: ThreadReference): Pair<String, String?>? = stops[t.uniqueID()]?.let { it.reason to it.description }

    fun stoppedException(t: ThreadReference): ObjectReference? = stops[t.uniqueID()]?.exception

    /** DAP `continue`. Returns true when all threads were resumed. */
    fun resume(threadId: Int?): Boolean {
        val t = threadId?.let { threadIds.thread(it) }
        val stop = t?.let { stops[it.uniqueID()] }
        if (t == null || pausedAll || stop?.eventSet?.suspendPolicy() == EventRequest.SUSPEND_ALL) {
            clearCoroutineSteps()
            resumeAll(); return true
        }
        coroutineSteps.filter { it.thread == t }.forEach { it.cleanupCoroutine() }
        resumeThread(t)
        return false
    }

    private fun resumeThread(t: ThreadReference) {
        clearThreadHandles(t.uniqueID())
        val stop = stops.remove(t.uniqueID())
        when {
            stop?.eventSet != null -> stop.eventSet.resume()
            runCatching { t.suspendCount() > 0 }.getOrDefault(false) -> t.resume()
        }
    }

    fun resumeAll() {
        frames.clear(); variables.clear(); values.clearCache(); stackCache.clear()
        pinned.keys.toList().forEach(::unpin)
        // Threads in the middle of a condition evaluation are left to their evaluator.
        val all = stops.values.filter { !it.probe }
        all.forEach { stops.remove(it.thread.uniqueID(), it) }
        for (s in all) runCatching { s.eventSet?.resume() ?: s.thread.resume() }
        if (pausedAll) {
            pausedAll = false
            runCatching { vm.resume() }
        }
    }

    fun pause(threadId: Int?) {
        clearCoroutineSteps()
        vm.suspend()
        pausedAll = true
        val t = threadId?.let { threadIds.thread(it) }
            ?: allThreads().firstOrNull { runCatching { it.name() == "main" }.getOrDefault(false) }
            ?: allThreads().firstOrNull()
        events.stopped(t?.let { threadIds.idOf(it) } ?: (threadId ?: 1), "pause", allThreadsStopped = true)
    }

    private val stackCache = ConcurrentHashMap<Long, List<dev.ktdebug.jdi.FrameView>>()

    /** The (possibly expensive) Kotlin-aware stack of a stopped thread, built once per stop. */
    fun stackOf(t: ThreadReference, threadId: Int): List<dev.ktdebug.jdi.FrameView> =
        stackCache.computeIfAbsent(t.uniqueID()) { stacks.build(t, threadId) }

    private fun clearThreadHandles(uid: Long) {
        stackCache.remove(uid)
        values.clearCache()
        frames.clearOwner(uid)
        variables.clearOwner(uid)
        unpin(uid)
    }

    /** Keeps an object alive (not garbage collected) while the thread stays stopped. */
    fun pin(owner: Long, obj: ObjectReference) {
        if (runCatching { obj.disableCollection() }.isSuccess) {
            pinned.computeIfAbsent(owner) { CopyOnWriteArrayList() }.add(obj)
        }
    }

    private fun unpin(owner: Long) {
        pinned.remove(owner)?.forEach { runCatching { it.enableCollection() } }
    }

    // ---------------------------------------------------------------- threads

    fun allThreads(): List<ThreadReference> {
        val result = LinkedHashMap<Long, ThreadReference>()
        runCatching { vm.allThreads() }.getOrDefault(emptyList()).forEach { result[it.uniqueID()] = it }
        val live = result.values.filter { runCatching { it.status() != ThreadReference.THREAD_STATUS_ZOMBIE }.getOrDefault(true) }
        // Virtual threads are not listed by allThreads() but must be visible while stopped.
        val stopped = stops.values.map { it.thread }.filter { s -> live.none { it.uniqueID() == s.uniqueID() } }
        return live + stopped
    }

    fun threadName(t: ThreadReference): String {
        val virtual = isVirtual(t)
        val name = runCatching { t.name() }.getOrDefault("<unknown>").ifEmpty { "virtual-thread-${t.uniqueID()}" }
        return if (virtual) "$name (virtual)" else name
    }

    /** JDK 21+ `ThreadReference.isVirtual()`, looked up via the public interface (adapter may run on 17). */
    fun isVirtual(t: ThreadReference): Boolean =
        isVirtualMethod?.let { m -> runCatching { m.invoke(t) as Boolean }.getOrDefault(false) } ?: false

    private val isVirtualMethod = runCatching { ThreadReference::class.java.getMethod("isVirtual") }.getOrNull()

    fun threadByUid(uid: Long): ThreadReference? =
        stops[uid]?.thread ?: allThreads().firstOrNull { it.uniqueID() == uid }

    fun thread(threadId: Int): ThreadReference =
        threadIds.thread(threadId) ?: throw IllegalArgumentException("Unknown thread id $threadId")

    // ====================================================================== stepping

    inner class StepContext(
        val kind: StepKind,
        val thread: ThreadReference,
        val startLocation: Location,
        val startDepth: Int,
        val startInlined: Boolean,
        val startKotlinSource: String?,
        val skipLine: Int? = null,
    ) {
        var iterations = 0
        var stepRequest: StepRequest? = null
        /** Library packages learned while stepping into (adaptive "just my code"). */
        val dynamicExclusions = LinkedHashSet<String>()
        // coroutine-aware step over
        var suspendMethod: Method? = null
        var continuation: ObjectReference? = null
        var isLambda = false
        var exitRequest: MethodExitRequest? = null
        val resumeRequests = CopyOnWriteArrayList<BreakpointRequest>()
        /** Set when the frame returned COROUTINE_SUSPENDED (or the coroutine resumed elsewhere). */
        @Volatile var suspended = false

        fun cleanupCoroutine() {
            val erm = vm.eventRequestManager()
            exitRequest?.let { runCatching { erm.deleteEventRequest(it) } }
            exitRequest = null
            resumeRequests.forEach { runCatching { erm.deleteEventRequest(it) } }
            resumeRequests.clear()
            continuation?.let { runCatching { it.enableCollection() } }
            coroutineSteps.remove(this)
        }
    }

    fun step(threadId: Int, kind: StepKind) {
        val t = thread(threadId)
        cancelSteps(t)
        val frame0 = t.frame(0)
        val loc = frame0.location()
        val ctx = StepContext(
            kind, t, loc, t.frameCount(),
            startInlined = Kotlin.isInlinedBody(loc),
            startKotlinSource = Kotlin.sourcePos(loc)?.sourceName,
        )
        if (kind == StepKind.OVER && config.coroutineStepping) setupCoroutineStep(ctx, frame0)
        createStep(ctx, kind)
        releaseForStep(t)
    }

    private fun releaseForStep(t: ThreadReference) {
        clearThreadHandles(t.uniqueID())
        val stop = stops.remove(t.uniqueID())
        if (stop?.eventSet?.suspendPolicy() == EventRequest.SUSPEND_ALL) {
            stop.eventSet.resume(); return
        }
        stop?.eventSet?.resume()
        if (pausedAll) {
            // Other threads stay paused; only the stepping thread runs.
            while (runCatching { t.suspendCount() > 0 }.getOrDefault(false)) t.resume()
        }
    }

    private fun createStep(ctx: StepContext, kind: StepKind) {
        val erm = vm.eventRequestManager()
        erm.stepRequests().filter { it.thread() == ctx.thread }.forEach { erm.deleteEventRequest(it) }
        val depth = when (kind) {
            StepKind.OVER -> StepRequest.STEP_OVER
            StepKind.INTO -> StepRequest.STEP_INTO
            StepKind.OUT -> StepRequest.STEP_OUT
        }
        ctx.stepRequest = erm.createStepRequest(ctx.thread, StepRequest.STEP_LINE, depth).apply {
            if (kind == StepKind.INTO) (config.stepFilters + ctx.dynamicExclusions).forEach { addClassExclusionFilter(it) }
            addCountFilter(1)
            setSuspendPolicy(breakpointSuspendPolicy)
            putProperty(STEP_KEY, ctx)
            enable()
        }
    }

    private fun cancelSteps(t: ThreadReference) {
        val erm = vm.eventRequestManager()
        runCatching { erm.stepRequests().filter { it.thread() == t }.forEach { erm.deleteEventRequest(it) } }
        coroutineSteps.filter { it.thread == t }.forEach { it.cleanupCoroutine() }
    }

    private fun clearCoroutineSteps() {
        coroutineSteps.toList().forEach { it.cleanupCoroutine() }
    }

    private fun onStep(ev: StepEvent): Outcome {
        val ctx = ev.request().getProperty(STEP_KEY) as? StepContext ?: return Outcome.Stop("step")
        runCatching { vm.eventRequestManager().deleteEventRequest(ev.request()) }
        val t = ev.thread()
        val loc = ev.location()
        ctx.iterations++
        val next = nextStepKind(ctx, t, loc)
        if (next != null && ctx.iterations < MAX_STEP_ITERATIONS) {
            createStep(ctx, next)
            return Outcome.Resume
        }
        ctx.cleanupCoroutine()
        return Outcome.Stop("step")
    }

    /** Decides whether a step event is a place the user wants to stop; if not, how to continue. */
    private fun nextStepKind(ctx: StepContext, t: ThreadReference, loc: Location): StepKind? {
        val method = loc.method()
        val typeName = loc.declaringType().name()
        // No line information / synthetic plumbing: keep going in the same direction.
        if (loc.lineNumber() < 0 || Kotlin.isStepThroughMethod(method)) {
            return if (ctx.kind == StepKind.INTO) StepKind.INTO else if (ctx.kind == StepKind.OUT) StepKind.OUT else StepKind.OVER
        }
        val depth = runCatching { t.frameCount() }.getOrDefault(-1)
        if (ctx.kind == StepKind.INTO && !isProjectCode(loc)) {
            // Stepped into library code without sources: exclude its package and keep going so the
            // JDWP agent skips it wholesale until application code runs again.
            libraryExclusion(typeName)?.let { if (ctx.dynamicExclusions.add(it)) return StepKind.INTO }
        }
        if (ctx.kind == StepKind.OVER || ctx.kind == StepKind.OUT) {
            // Returned into coroutine machinery: continue to the next user code (the resumed caller).
            if (isCoroutineMachinery(typeName)) return StepKind.INTO
        }
        if (ctx.kind == StepKind.OVER && depth == ctx.startDepth && loc.method() == ctx.startLocation.method()) {
            // Coroutine state machine plumbing (dispatch, `return COROUTINE_SUSPENDED`, resume
            // restoration) is attributed to the function's declaration line: never stop there.
            if ((Kotlin.isSuspendFunction(method) || Kotlin.isInvokeSuspend(method)) &&
                Kotlin.sourcePos(loc)?.line == declarationLine(method) && loc.codeIndex() > ctx.startLocation.codeIndex()
            ) return StepKind.OVER
            val inlined = Kotlin.isInlinedBody(loc)
            // Stepping over a call to an inline function must not stop inside its body.
            if (inlined && !ctx.startInlined) return StepKind.OVER
            if (inlined && ctx.startInlined && Kotlin.sourcePos(loc)?.sourceName != ctx.startKotlinSource) return StepKind.OVER
            if (ctx.skipLine != null && Kotlin.sourcePos(loc)?.line == ctx.skipLine) return StepKind.OVER
        }
        return null
    }

    /** Code is "project code" when its source file is in the workspace. */
    private fun isProjectCode(loc: Location): Boolean {
        val pos = Kotlin.sourcePos(loc) ?: return false
        return sources.resolve(Kotlin.packageDirOf(pos.sourcePath), pos.sourceName) != null
    }

    /** A class-exclusion pattern covering the library package of [typeName] but no project package. */
    private fun libraryExclusion(typeName: String): String? {
        val pkg = typeName.substringBeforeLast('.', "")
        if (pkg.isEmpty() || pkg in sources.projectPackages) return null
        val segments = pkg.split('.')
        var k = minOf(2, segments.size)
        while (k < segments.size && sources.projectPackages.any { it == segments.take(k).joinToString(".") || it.startsWith(segments.take(k).joinToString(".") + ".") }) k++
        val prefix = segments.take(k).joinToString(".")
        if (sources.projectPackages.any { it == prefix || it.startsWith("$prefix.") }) return null
        return "$prefix.*"
    }

    private fun declarationLine(method: Method): Int? =
        runCatching { method.allLineLocations().firstOrNull()?.let { Kotlin.sourcePos(it)?.line } }.getOrNull()

    private fun isCoroutineMachinery(typeName: String) =
        typeName.startsWith("kotlin.coroutines.") || typeName.startsWith("kotlinx.coroutines.")

    // ---------------------------------------------------------------- coroutine step over

    /**
     * Step over in a suspend function. If the current call suspends, the frame returns
     * COROUTINE_SUSPENDED and the code continues later, possibly on another thread. We watch the
     * frame's exit; on suspension we cancel the plain step and wait at the function's line
     * locations for the *same* continuation object to resume, then finish the step there.
     */
    private fun setupCoroutineStep(ctx: StepContext, frame: com.sun.jdi.StackFrame) {
        val method = frame.location().method()
        val isLambda = Kotlin.isInvokeSuspend(method)
        if (!isLambda && !Kotlin.isSuspendFunction(method)) return
        val continuation = if (isLambda) frame.thisObject() else {
            Kotlin.visibleLocalsSafe(frame).firstOrNull { it.name() == "\$continuation" }?.let { frame.getValue(it) as? ObjectReference }
        } ?: return
        if (!vm.canGetMethodReturnValues()) return
        runCatching { continuation.disableCollection() }
        ctx.suspendMethod = method
        ctx.continuation = continuation
        ctx.isLambda = isLambda
        val erm = vm.eventRequestManager()
        ctx.exitRequest = erm.createMethodExitRequest().apply {
            addThreadFilter(ctx.thread)
            addClassFilter(method.declaringType())
            setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD)
            putProperty(STEP_KEY, ctx)
            enable()
        }
        // Installed *before* the thread runs: after a suspension the coroutine may be resumed on
        // another thread (e.g. by delay()'s timer) before we would get to install them.
        for (loc in runCatching { method.allLineLocations() }.getOrDefault(emptyList())) {
            runCatching {
                ctx.resumeRequests += erm.createBreakpointRequest(loc).apply {
                    if (isLambda) addInstanceFilter(continuation)
                    setSuspendPolicy(breakpointSuspendPolicy)
                    putProperty(RESUME_KEY, ctx)
                    enable()
                }
            }
        }
        coroutineSteps += ctx
    }

    private fun onMethodExit(ev: MethodExitEvent): Outcome {
        val ctx = ev.request().getProperty(STEP_KEY) as? StepContext ?: return Outcome.Resume
        if (ev.method() != ctx.suspendMethod) return Outcome.Resume
        val depth = runCatching { ev.thread().frameCount() }.getOrDefault(-1)
        if (depth != ctx.startDepth) return Outcome.Resume
        runCatching { vm.eventRequestManager().deleteEventRequest(ev.request()) }
        ctx.exitRequest = null
        if (!isCoroutineSuspended(ev.returnValue())) {
            // Normal return: the plain step finishes in the caller; drop the resume watchers.
            ctx.cleanupCoroutine()
            return Outcome.Resume
        }
        // Suspended: drop the plain step and wait for this coroutine to resume.
        ctx.suspended = true
        ctx.stepRequest?.let { runCatching { vm.eventRequestManager().deleteEventRequest(it) } }
        Log.debug { "Coroutine suspended in ${ctx.suspendMethod?.name()}; waiting for resumption of ${ctx.continuation}" }
        return Outcome.Resume
    }

    private fun isCoroutineSuspended(v: Value?): Boolean {
        val obj = v as? ObjectReference ?: return false
        if (obj.referenceType().name() != "kotlin.coroutines.intrinsics.CoroutineSingletons") return false
        val nameField = obj.referenceType().fieldByName("name") ?: (obj.referenceType() as? ClassType)?.superclass()?.fieldByName("name")
        return (nameField?.let { obj.getValue(it) } as? StringReference)?.value() == "COROUTINE_SUSPENDED"
    }

    private fun onCoroutineResume(ev: BreakpointEvent, ctx: StepContext): Outcome {
        val t = ev.thread()
        // Before the suspension is confirmed, the stepping thread itself is just executing the
        // function normally; the plain step request handles that.
        if (!ctx.suspended && t == ctx.thread) return Outcome.Resume
        if (!ctx.isLambda) {
            val frame = t.frame(0)
            val current = Kotlin.visibleLocalsSafe(frame).firstOrNull { it.name() == "\$continuation" }?.let { frame.getValue(it) }
            if (current != ctx.continuation) return Outcome.Resume
        }
        // Resumed (possibly on another thread before we even saw the suspending return).
        ctx.stepRequest?.let { runCatching { vm.eventRequestManager().deleteEventRequest(it) } }
        ctx.cleanupCoroutine()
        val loc = ev.location()
        // We are back in the same coroutine, somewhere in the state machine's dispatch/restore
        // code or on the suspending call line itself: finish the step on the next real line.
        val resumed = StepContext(
            StepKind.OVER, t, loc, t.frameCount(), Kotlin.isInlinedBody(loc), Kotlin.sourcePos(loc)?.sourceName,
            skipLine = Kotlin.sourcePos(ctx.startLocation)?.line,
        )
        createStep(resumed, StepKind.OVER)
        return Outcome.Resume
    }

    // ====================================================================== method invocation

    /**
     * Invokes a method in the debuggee on a thread stopped by an event. Only that thread runs
     * (INVOKE_SINGLE_THREADED); a watchdog interrupts invocations that take too long.
     */
    fun invoke(t: ThreadReference, target: Any, method: Method, args: List<Value?>): Value? {
        var attempts = 0
        while (true) {
            try {
                return invokeOnce(t, target, method, args)
            } catch (e: com.sun.jdi.ClassNotLoadedException) {
                // JDI requires argument types to be loaded by the method's class loader; e.g.
                // java.lang.Iterable may never have been requested through the app loader.
                if (attempts++ > 3 || !loadThroughLoader(t, method.declaringType().classLoader(), e.className())) {
                    throw EvalException("Class ${e.className()} is not loaded in the debuggee")
                }
            }
        }
    }

    private fun loadThroughLoader(t: ThreadReference, loader: com.sun.jdi.ClassLoaderReference?, name: String): Boolean {
        val classType = vm.classesByName("java.lang.Class").firstOrNull() as? ClassType ?: return false
        val forName = classType.concreteMethodByName("forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;") ?: return false
        val nameRef = vm.mirrorOf(name).also { pin(t.uniqueID(), it) }
        return runCatching { invokeOnce(t, classType, forName, listOf(nameRef, vm.mirrorOf(false), loader)) }.isSuccess
    }

    private fun invokeOnce(t: ThreadReference, target: Any, method: Method, args: List<Value?>): Value? {
        if (!isStoppedByEvent(t)) {
            throw EvalException("Method calls need a thread stopped at a breakpoint or step (this thread was paused)")
        }
        val uid = t.uniqueID()
        invokingThreads += uid
        val timer = watchdog.schedule({
            Log.warn("Invocation of ${method.declaringType().name()}.${method.name()} exceeded ${config.invocationTimeoutMs} ms; interrupting")
            runCatching { t.interrupt() }
        }, config.invocationTimeoutMs, TimeUnit.MILLISECONDS)
        try {
            val opts = ObjectReference.INVOKE_SINGLE_THREADED
            val result = when (target) {
                is ObjectReference -> target.invokeMethod(t, method, args, opts)
                is ClassType -> target.invokeMethod(t, method, args, opts)
                is InterfaceType -> target.invokeMethod(t, method, args, opts)
                else -> throw EvalException("Cannot invoke on $target")
            }
            (result as? ObjectReference)?.let { pin(uid, it) }
            return result
        } catch (e: InvocationException) {
            val ex = e.exception()
            throw EvalException("${method.name()}() threw ${ex.referenceType().name()}" + (values.throwableMessage(ex)?.let { ": $it" } ?: ""))
        } catch (e: IncompatibleThreadStateException) {
            throw EvalException("Thread is not suspended at a breakpoint; method calls are unavailable")
        } catch (e: ObjectCollectedException) {
            throw EvalException("Object was garbage collected")
        } finally {
            timer.cancel(false)
            invokingThreads -= uid
        }
    }

    companion object {
        const val STEP_KEY = "ktdebug.step"
        const val RESUME_KEY = "ktdebug.coroutineResume"
        private const val MAX_STEP_ITERATIONS = 200
    }
}
