package dev.ktdebug.dap

import com.sun.jdi.ObjectReference
import dev.ktdebug.VERSION
import dev.ktdebug.eval.EvalException
import dev.ktdebug.jdi.ArrayContainer
import dev.ktdebug.jdi.FrameView
import dev.ktdebug.jdi.Kotlin
import dev.ktdebug.jdi.LocalsContainer
import dev.ktdebug.jdi.ObjectContainer
import dev.ktdebug.jdi.StackBuilder
import dev.ktdebug.jdi.VarView
import dev.ktdebug.session.BreakpointManager
import dev.ktdebug.session.ConnectException2
import dev.ktdebug.session.DebugEvents
import dev.ktdebug.session.DebugSession
import dev.ktdebug.session.FrameRef
import dev.ktdebug.session.LineBreakpoint
import dev.ktdebug.session.LineSpec
import dev.ktdebug.session.SessionConfig
import dev.ktdebug.session.SourceIndex
import dev.ktdebug.session.StepKind
import dev.ktdebug.session.VmConnector
import dev.ktdebug.util.HitCondition
import dev.ktdebug.util.Log
import org.eclipse.lsp4j.debug.Breakpoint
import org.eclipse.lsp4j.debug.BreakpointEventArguments
import org.eclipse.lsp4j.debug.BreakpointEventArgumentsReason
import org.eclipse.lsp4j.debug.Capabilities
import org.eclipse.lsp4j.debug.CompletionItem
import org.eclipse.lsp4j.debug.CompletionItemType
import org.eclipse.lsp4j.debug.CompletionsArguments
import org.eclipse.lsp4j.debug.CompletionsResponse
import org.eclipse.lsp4j.debug.ConfigurationDoneArguments
import org.eclipse.lsp4j.debug.ContinueArguments
import org.eclipse.lsp4j.debug.ContinueResponse
import org.eclipse.lsp4j.debug.ContinuedEventArguments
import org.eclipse.lsp4j.debug.DisconnectArguments
import org.eclipse.lsp4j.debug.EvaluateArguments
import org.eclipse.lsp4j.debug.EvaluateResponse
import org.eclipse.lsp4j.debug.ExceptionBreakMode
import org.eclipse.lsp4j.debug.ExceptionBreakpointsFilter
import org.eclipse.lsp4j.debug.ExceptionDetails
import org.eclipse.lsp4j.debug.ExceptionInfoArguments
import org.eclipse.lsp4j.debug.ExceptionInfoResponse
import org.eclipse.lsp4j.debug.ExitedEventArguments
import org.eclipse.lsp4j.debug.InitializeRequestArguments
import org.eclipse.lsp4j.debug.NextArguments
import org.eclipse.lsp4j.debug.OutputEventArguments
import org.eclipse.lsp4j.debug.PauseArguments
import org.eclipse.lsp4j.debug.Scope
import org.eclipse.lsp4j.debug.ScopePresentationHint
import org.eclipse.lsp4j.debug.ScopesArguments
import org.eclipse.lsp4j.debug.ScopesResponse
import org.eclipse.lsp4j.debug.SetBreakpointsArguments
import org.eclipse.lsp4j.debug.SetBreakpointsResponse
import org.eclipse.lsp4j.debug.SetExceptionBreakpointsArguments
import org.eclipse.lsp4j.debug.SetExceptionBreakpointsResponse
import org.eclipse.lsp4j.debug.SetFunctionBreakpointsArguments
import org.eclipse.lsp4j.debug.SetFunctionBreakpointsResponse
import org.eclipse.lsp4j.debug.SetVariableArguments
import org.eclipse.lsp4j.debug.SetVariableResponse
import org.eclipse.lsp4j.debug.Source
import org.eclipse.lsp4j.debug.SourcePresentationHint
import org.eclipse.lsp4j.debug.StackFrame
import org.eclipse.lsp4j.debug.StackFramePresentationHint
import org.eclipse.lsp4j.debug.StackTraceArguments
import org.eclipse.lsp4j.debug.StackTraceResponse
import org.eclipse.lsp4j.debug.StepInArguments
import org.eclipse.lsp4j.debug.StepOutArguments
import org.eclipse.lsp4j.debug.StoppedEventArguments
import org.eclipse.lsp4j.debug.TerminateArguments
import org.eclipse.lsp4j.debug.TerminatedEventArguments
import org.eclipse.lsp4j.debug.Thread as DapThread
import org.eclipse.lsp4j.debug.ThreadEventArguments
import org.eclipse.lsp4j.debug.ThreadsResponse
import org.eclipse.lsp4j.debug.Variable
import org.eclipse.lsp4j.debug.VariablePresentationHint
import org.eclipse.lsp4j.debug.VariablesArguments
import org.eclipse.lsp4j.debug.VariablesResponse
import org.eclipse.lsp4j.debug.services.IDebugProtocolClient
import org.eclipse.lsp4j.debug.services.IDebugProtocolServer
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import org.eclipse.lsp4j.jsonrpc.messages.ResponseError
import java.nio.file.Paths
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

/** DAP endpoint: translates Debug Adapter Protocol requests into [DebugSession] operations. */
class KotlinDebugServer : IDebugProtocolServer {
    private lateinit var client: IDebugProtocolClient
    @Volatile private var session: DebugSession? = null
    private var lineBase = 1
    /** All requests are serialized so JDI state changes happen in protocol order. */
    private val serial = Executors.newSingleThreadExecutor { r -> Thread(r, "kda-requests").apply { isDaemon = true } }
    private val connectPool = Executors.newSingleThreadExecutor { r -> Thread(r, "kda-connect").apply { isDaemon = true } }
    @Volatile private var exceptionFilters = listOf(BreakpointManager.ExceptionFilter(BreakpointManager.FILTER_UNCAUGHT, null))

    fun connect(client: IDebugProtocolClient) {
        this.client = client
        Log.consoleSink = { text -> output(text, "console") }
    }

    fun shutdown() {
        runCatching { session?.disconnect(terminateDebuggee = session?.config?.isAttach == false) }
        serial.shutdownNow()
        connectPool.shutdownNow()
    }

    // ------------------------------------------------------------------ helpers

    private fun <T> onSerial(block: () -> T): CompletableFuture<T> =
        CompletableFuture.supplyAsync({
            try {
                block()
            } catch (e: ResponseErrorException) {
                throw e
            } catch (e: EvalException) {
                throw error(e.message ?: "Evaluation failed")
            } catch (e: com.sun.jdi.VMDisconnectedException) {
                throw error("The debuggee VM is disconnected")
            } catch (e: Exception) {
                Log.warn("Request failed", e)
                throw error(e.message ?: e.javaClass.simpleName)
            }
        }, serial)

    @Suppress("UNCHECKED_CAST")
    private fun onSerialVoid(block: () -> Unit): CompletableFuture<Void> =
        onSerial<Any?> { block(); null } as CompletableFuture<Void>

    private fun error(message: String) = ResponseErrorException(ResponseError(1, message, null))

    private fun requireSession(): DebugSession = session ?: throw error("No active debug session")

    private fun output(text: String, category: String) {
        if (!::client.isInitialized) return
        client.output(OutputEventArguments().apply { this.category = category; this.output = text })
    }

    private fun toClientLine(line: Int) = line - 1 + lineBase
    private fun fromClientLine(line: Int) = line + 1 - lineBase

    // ------------------------------------------------------------------ lifecycle

    override fun initialize(args: InitializeRequestArguments): CompletableFuture<Capabilities> {
        lineBase = if (args.linesStartAt1 == false) 0 else 1
        return CompletableFuture.completedFuture(Capabilities().apply {
            supportsConfigurationDoneRequest = true
            supportsFunctionBreakpoints = true
            supportsConditionalBreakpoints = true
            supportsHitConditionalBreakpoints = true
            supportsLogPoints = true
            supportsEvaluateForHovers = true
            supportsSetVariable = true
            supportsExceptionInfoRequest = true
            supportsExceptionFilterOptions = true
            supportsDelayedStackTraceLoading = true
            supportsCompletionsRequest = true
            supportsTerminateRequest = true
            supportTerminateDebuggee = true
            supportsClipboardContext = true
            exceptionBreakpointFilters = arrayOf(
                filter(BreakpointManager.FILTER_UNCAUGHT, "Uncaught Exceptions", true,
                    "Stop when an exception is not caught by any handler"),
                filter(BreakpointManager.FILTER_USER_CAUGHT, "Caught Exceptions (application code)", false,
                    "Stop when application code throws an exception that is caught somewhere (e.g. by Spring). " +
                        "Exceptions thrown inside JDK/framework/library code are ignored."),
                filter(BreakpointManager.FILTER_CAUGHT, "All Caught Exceptions", false,
                    "Stop on every caught exception, including JDK and framework internals (noisy)"),
            )
        })
    }

    private fun filter(id: String, label: String, default: Boolean, description: String) = ExceptionBreakpointsFilter().apply {
        this.filter = id
        this.label = label
        this.default_ = default
        this.description = description
        this.supportsCondition = true
        this.conditionDescription = "Comma-separated exception class names, e.g. IllegalStateException, com.example.OrderNotFoundException"
    }

    override fun launch(args: MutableMap<String, Any>): CompletableFuture<Void> = connect("launch", args)
    override fun attach(args: MutableMap<String, Any>): CompletableFuture<Void> = connect("attach", args)

    @Suppress("UNCHECKED_CAST")
    private fun connect(request: String, args: Map<String, Any>): CompletableFuture<Void> = CompletableFuture.supplyAsync<Any?>({
        (args["logLevel"] as? String)?.let { lvl -> runCatching { Log.level = Log.Level.valueOf(lvl.uppercase()) } }
        val config = SessionConfig.from(request, args)
        val roots = (listOfNotNull(config.projectRoot) + config.sourcePaths).distinct()
        val sources = SourceIndex(roots).build()
        val events = Events()
        try {
            val session = if (config.isAttach) {
                val vm = VmConnector.attach(config.hostName, config.port, config.timeoutMs) { msg -> output(msg, "console") }
                DebugSession(vm, config, sources, events)
            } else {
                val launched = VmConnector.launch(config) { text, cat -> output(text, cat) }
                DebugSession(launched.vm, config, sources, events, launched.process)
            }
            this.session = session
            session.start()
            val vm = session.vm
            output(
                "Kotlin debugger $VERSION ${if (config.isAttach) "attached to" else "launched"} ${vm.name()} ${vm.version()}" +
                    (if (config.isAttach) " at ${config.hostName}:${config.port}" else "") +
                    " — ${sources.fileCount} source files indexed\n",
                "console",
            )
            if (sources.fileCount == 0) {
                output("[kotlin-debug] WARNING: no .kt/.java sources found under ${roots.joinToString()}. " +
                    "Set 'projectRoot'/'sourcePaths' so breakpoints can be mapped.\n", "important")
            }
            client.initialized()
        } catch (e: ConnectException2) {
            throw error(e.message ?: "Could not connect")
        } catch (e: Exception) {
            Log.error("$request failed", e)
            throw error("$request failed: ${e.message ?: e.javaClass.simpleName}")
        }
        null
    }, connectPool) as CompletableFuture<Void>

    override fun configurationDone(args: ConfigurationDoneArguments?): CompletableFuture<Void> = onSerialVoid {
        session?.let { s ->
            s.breakpoints.setExceptionBreakpoints(exceptionFilters)
            s.configurationDone()
        }
    }

    override fun disconnect(args: DisconnectArguments?): CompletableFuture<Void> = onSerialVoid {
        val s = session
        if (s != null) {
            val terminate = args?.terminateDebuggee ?: !s.config.isAttach
            s.disconnect(terminate)
            session = null
        }
    }

    override fun terminate(args: TerminateArguments?): CompletableFuture<Void> = onSerialVoid {
        session?.let { s ->
            // Never kill a JVM we merely attached to; detach instead.
            s.disconnect(terminateDebuggee = !s.config.isAttach)
        }
    }

    // ------------------------------------------------------------------ breakpoints

    override fun setBreakpoints(args: SetBreakpointsArguments): CompletableFuture<SetBreakpointsResponse> = onSerial {
        val path = args.source?.path
        val specs = (args.breakpoints ?: emptyArray()).map {
            LineSpec(fromClientLine(it.line), it.condition?.takeIf { c -> c.isNotBlank() }, it.hitCondition?.takeIf { c -> c.isNotBlank() }, it.logMessage)
        }
        val s = session
        val bps: List<LineBreakpoint> = if (s == null || path == null) {
            specs.mapIndexed { i, sp -> LineBreakpoint(-(i + 1), null, sp.line, null, null, null).apply { message = "No debug session" } }
        } else s.breakpoints.setLineBreakpoints(Paths.get(path), specs)
        SetBreakpointsResponse().apply {
            breakpoints = bps.map { bp ->
                toDap(bp).also { d ->
                    bp.hitCondition?.let { hc -> if (!HitCondition.isValid(hc)) d.message = "Invalid hit condition '$hc' (use 5, >5, >=5, %3)" }
                }
            }.toTypedArray()
        }
    }

    private fun toDap(bp: LineBreakpoint) = Breakpoint().apply {
        id = bp.id
        isVerified = bp.verified
        message = bp.message
        line = if (bp.functionName == null) toClientLine(bp.line) else bp.reportedLine.takeIf { it > 0 }?.let(::toClientLine)
        if (bp.file != null) source = Source().apply { path = bp.file.path.toString(); name = bp.file.fileName }
    }

    override fun setFunctionBreakpoints(args: SetFunctionBreakpointsArguments): CompletableFuture<SetFunctionBreakpointsResponse> = onSerial {
        val s = requireSession()
        val bps = s.breakpoints.setFunctionBreakpoints((args.breakpoints ?: emptyArray()).map { it.name to it.condition })
        SetFunctionBreakpointsResponse().apply { breakpoints = bps.map(::toDap).toTypedArray() }
    }

    override fun setExceptionBreakpoints(args: SetExceptionBreakpointsArguments): CompletableFuture<SetExceptionBreakpointsResponse> = onSerial {
        val filters = mutableListOf<BreakpointManager.ExceptionFilter>()
        args.filters?.forEach { filters += BreakpointManager.ExceptionFilter(it, null) }
        args.filterOptions?.forEach { o ->
            filters.removeIf { it.id == o.filterId }
            filters += BreakpointManager.ExceptionFilter(o.filterId, o.condition)
        }
        exceptionFilters = filters
        session?.breakpoints?.setExceptionBreakpoints(filters)
        SetExceptionBreakpointsResponse().apply {
            breakpoints = filters.map { Breakpoint().apply { isVerified = true } }.toTypedArray()
        }
    }

    // ------------------------------------------------------------------ execution control

    override fun continue_(args: ContinueArguments): CompletableFuture<ContinueResponse> = onSerial {
        val all = requireSession().resume(args.threadId)
        ContinueResponse().apply { allThreadsContinued = all }
    }

    override fun next(args: NextArguments): CompletableFuture<Void> = onSerialVoid { requireSession().step(args.threadId, StepKind.OVER) }
    override fun stepIn(args: StepInArguments): CompletableFuture<Void> = onSerialVoid { requireSession().step(args.threadId, StepKind.INTO) }
    override fun stepOut(args: StepOutArguments): CompletableFuture<Void> = onSerialVoid { requireSession().step(args.threadId, StepKind.OUT) }
    override fun pause(args: PauseArguments): CompletableFuture<Void> = onSerialVoid { requireSession().pause(args.threadId) }

    // ------------------------------------------------------------------ inspection

    override fun threads(): CompletableFuture<ThreadsResponse> = onSerial {
        val s = session
        ThreadsResponse().apply {
            threads = s?.allThreads()?.map { t ->
                DapThread().apply { id = s.threadIds.idOf(t); name = s.threadName(t) }
            }?.sortedBy { it.id }?.toTypedArray() ?: emptyArray()
        }
    }

    override fun stackTrace(args: StackTraceArguments): CompletableFuture<StackTraceResponse> = onSerial {
        val s = requireSession()
        val t = s.thread(args.threadId)
        val all = s.stackOf(t, args.threadId)
        val start = (args.startFrame ?: 0).coerceAtLeast(0)
        val levels = args.levels?.takeIf { it > 0 } ?: all.size
        StackTraceResponse().apply {
            stackFrames = all.drop(start).take(levels).map(::toDap).toTypedArray()
            totalFrames = all.size
        }
    }

    private fun toDap(f: FrameView) = StackFrame().apply {
        id = f.id
        name = f.name
        line = if (f.line > 0) toClientLine(f.line) else 0
        column = if (f.line > 0) 1 else 0
        presentationHint = when (f.hint) {
            "label" -> StackFramePresentationHint.LABEL
            "subtle" -> StackFramePresentationHint.SUBTLE
            else -> StackFramePresentationHint.NORMAL
        }
        if (f.sourcePath != null) {
            source = Source().apply { name = f.sourceName; path = f.sourcePath.toString() }
        } else if (f.sourceName != null) {
            source = Source().apply { name = f.sourceName; presentationHint = SourcePresentationHint.DEEMPHASIZE }
        }
    }

    override fun scopes(args: ScopesArguments): CompletableFuture<ScopesResponse> = onSerial {
        val s = requireSession()
        val ref = s.frames[args.frameId] ?: throw error("Stack frame ${args.frameId} is no longer valid")
        val name = when (ref.kind) {
            FrameRef.Kind.REAL -> "Locals"
            FrameRef.Kind.INLINE -> "Locals (inline function)"
            FrameRef.Kind.ASYNC -> "Coroutine state"
        }
        ScopesResponse().apply {
            scopes = arrayOf(Scope().apply {
                this.name = name
                presentationHint = ScopePresentationHint.LOCALS
                variablesReference = s.variables.create(ref.threadUid, LocalsContainer(ref))
                isExpensive = false
            })
        }
    }

    override fun variables(args: VariablesArguments): CompletableFuture<VariablesResponse> = onSerial {
        val s = requireSession()
        val container = s.variables[args.variablesReference] ?: throw error("Variables reference ${args.variablesReference} is no longer valid")
        val list = s.values.children(container, args.start, args.count)
        VariablesResponse().apply { variables = list.map(::toDap).toTypedArray() }
    }

    private fun toDap(v: VarView) = Variable().apply {
        name = v.name
        value = v.value
        type = v.type
        variablesReference = v.reference
        evaluateName = v.evaluateName
        if (v.indexed != null && v.indexed > 0) indexedVariables = v.indexed
        if (v.virtual) presentationHint = VariablePresentationHint().apply { kind = "virtual" }
    }

    override fun setVariable(args: SetVariableArguments): CompletableFuture<SetVariableResponse> = onSerial {
        val s = requireSession()
        val container = s.variables[args.variablesReference] ?: throw error("Variable is no longer valid")
        val view = when (container) {
            is LocalsContainer -> {
                val t = s.thread(container.frame.threadId)
                val v = s.evaluator.evaluate(t, container.frame.depth, container.frame.kind, "${args.name} = ${args.value}")
                s.values.view(args.name, v, t, args.name)
            }
            is ObjectContainer -> {
                val t = s.threadByUid(container.threadUid) ?: throw error("Thread is gone")
                val f = container.obj.referenceType().fieldByName(args.name)
                    ?: container.obj.referenceType().allFields().firstOrNull { Kotlin.displayName(it.name()) == args.name }
                    ?: throw error("Unknown field ${args.name}")
                val newValue = s.evaluator.evaluate(t, 0, FrameRef.Kind.REAL, args.value)
                val coerced = s.evaluator.coerceForSet(t, 0, newValue, f.typeName())
                container.obj.setValue(f, coerced)
                s.values.view(args.name, coerced, t, null)
            }
            is ArrayContainer -> {
                val t = s.threadByUid(container.threadUid) ?: throw error("Thread is gone")
                val idx = args.name.trim('[', ']').toInt()
                val newValue = s.evaluator.evaluate(t, 0, FrameRef.Kind.REAL, args.value)
                val coerced = s.evaluator.coerceForSet(t, 0, newValue, (container.array.type() as com.sun.jdi.ArrayType).componentTypeName())
                container.array.setValue(idx, coerced)
                s.values.view(args.name, coerced, t, null)
            }
            else -> throw error("This value cannot be modified")
        }
        SetVariableResponse().apply {
            value = view.value; type = view.type; variablesReference = view.reference
        }
    }

    override fun evaluate(args: EvaluateArguments): CompletableFuture<EvaluateResponse> = onSerial {
        val s = requireSession()
        val ref = args.frameId?.let { s.frames[it] } ?: defaultFrame(s)
            ?: throw error("Evaluation needs a stopped thread: pause or hit a breakpoint first")
        val t = s.thread(ref.threadId)
        if (ref.kind == FrameRef.Kind.ASYNC) throw error("Expressions cannot be evaluated in an async (suspended coroutine) frame")
        val value = s.evaluator.evaluate(t, ref.depth, ref.kind, args.expression)
        val view = s.values.view("result", value, t, args.expression.trim())
        EvaluateResponse().apply {
            result = if (args.context == "clipboard" && value is com.sun.jdi.StringReference) value.value() else view.value
            type = view.type
            variablesReference = view.reference
            view.indexed?.let { if (it > 0) indexedVariables = it }
        }
    }

    private fun defaultFrame(s: DebugSession): FrameRef? {
        val t = s.allThreads().firstOrNull { s.isStoppedByEvent(it) } ?: return null
        val id = s.threadIds.idOf(t)
        return FrameRef(t.uniqueID(), id, 0, FrameRef.Kind.REAL)
    }

    override fun completions(args: CompletionsArguments): CompletableFuture<CompletionsResponse> = onSerial {
        val s = requireSession()
        val ref = args.frameId?.let { s.frames[it] }
        val items = mutableListOf<CompletionItem>()
        if (ref != null && ref.kind != FrameRef.Kind.ASYNC) {
            val text = args.text.take((args.column - 1).coerceIn(0, args.text.length))
            val prefix = text.takeLastWhile { it.isLetterOrDigit() || it == '_' }
            val vars = s.values.locals(ref).map { it.name }
            val t = s.thread(ref.threadId)
            val members = runCatching { t.frame(ref.depth).thisObject() }.getOrNull()?.referenceType()?.let { type ->
                type.allFields().map { Kotlin.displayName(it.name()) } + type.visibleMethods().map { it.name() }
            }.orEmpty()
            (vars + members).filter { it.startsWith(prefix) && it.all { c -> c.isLetterOrDigit() || c == '_' || c == '@' } }
                .distinct().forEach { n ->
                    items += CompletionItem().apply { label = n; type = if (n in vars) CompletionItemType.VARIABLE else CompletionItemType.PROPERTY }
                }
        }
        CompletionsResponse().apply { targets = items.toTypedArray() }
    }

    override fun exceptionInfo(args: ExceptionInfoArguments): CompletableFuture<ExceptionInfoResponse> = onSerial {
        val s = requireSession()
        val t = s.thread(args.threadId)
        val ex: ObjectReference = s.stoppedException(t) ?: throw error("Thread is not stopped on an exception")
        val type = ex.referenceType().name()
        val message = s.values.throwableMessage(ex)
        val trace = runCatching {
            t.frames().joinToString("\n") { f ->
                val loc = f.location()
                val pos = Kotlin.sourcePos(loc)
                "\tat ${loc.declaringType().name()}.${loc.method().name()}(${pos?.sourceName ?: "Unknown Source"}:${pos?.line ?: -1})"
            }
        }.getOrNull()
        ExceptionInfoResponse().apply {
            exceptionId = type
            description = message ?: type
            breakMode = ExceptionBreakMode.ALWAYS
            details = ExceptionDetails().apply {
                this.message = message
                typeName = type.substringAfterLast('.')
                fullTypeName = type
                stackTrace = trace
            }
        }
    }

    // ------------------------------------------------------------------ events

    private inner class Events : DebugEvents {
        override fun stopped(threadId: Int, reason: String, description: String?, text: String?, hitBreakpointIds: List<Int>, allThreadsStopped: Boolean) {
            client.stopped(StoppedEventArguments().apply {
                this.reason = reason
                this.threadId = threadId
                this.description = description
                this.text = text
                this.allThreadsStopped = allThreadsStopped
                if (hitBreakpointIds.isNotEmpty()) this.hitBreakpointIds = hitBreakpointIds.toTypedArray()
            })
        }

        override fun continued(threadId: Int, allThreads: Boolean) {
            client.continued(ContinuedEventArguments().apply { this.threadId = threadId; allThreadsContinued = allThreads })
        }

        override fun output(text: String, category: String) = this@KotlinDebugServer.output(text, category)

        override fun thread(threadId: Int, started: Boolean) {
            client.thread(ThreadEventArguments().apply { this.threadId = threadId; reason = if (started) "started" else "exited" })
        }

        override fun breakpointChanged(bp: LineBreakpoint) {
            client.breakpoint(BreakpointEventArguments().apply {
                reason = BreakpointEventArgumentsReason.CHANGED
                breakpoint = toDap(bp)
            })
        }

        override fun terminated() {
            client.terminated(TerminatedEventArguments())
        }

        override fun exited(exitCode: Int) {
            client.exited(ExitedEventArguments().apply { this.exitCode = exitCode })
        }
    }
}
