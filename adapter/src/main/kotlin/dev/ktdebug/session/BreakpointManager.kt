package dev.ktdebug.session

import com.sun.jdi.AbsentInformationException
import com.sun.jdi.ArrayType
import com.sun.jdi.ClassNotPreparedException
import com.sun.jdi.Location
import com.sun.jdi.ObjectCollectedException
import com.sun.jdi.ReferenceType
import com.sun.jdi.event.ClassPrepareEvent
import com.sun.jdi.request.BreakpointRequest
import com.sun.jdi.request.ClassPrepareRequest
import com.sun.jdi.request.EventRequest
import com.sun.jdi.request.ExceptionRequest
import dev.ktdebug.jdi.Kotlin
import dev.ktdebug.util.Log
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** A user breakpoint on a source line. Bound to zero or more JVM locations. */
class LineBreakpoint(
    val id: Int,
    val file: SourceIndex.SourceFile?,
    val line: Int,
    val condition: String?,
    val hitCondition: String?,
    val logMessage: String?,
    /** For function breakpoints: the display name; [file] is null. */
    val functionName: String? = null,
) {
    val requests = CopyOnWriteArrayList<BreakpointRequest>()
    private val boundLocations = ConcurrentHashMap.newKeySet<Location>()
    val hits = AtomicInteger()
    @Volatile var verified = false
    @Volatile var message: String? = null
    @Volatile var reportedLine: Int = line

    fun sameSpec(line: Int, condition: String?, hitCondition: String?, logMessage: String?) =
        this.line == line && this.condition == condition && this.hitCondition == hitCondition && this.logMessage == logMessage

    internal fun markBound(location: Location) = boundLocations.add(location)
}

data class LineSpec(val line: Int, val condition: String?, val hitCondition: String?, val logMessage: String?)

class BreakpointManager(private val session: DebugSession) {
    private val vm get() = session.vm
    private val erm get() = session.vm.eventRequestManager()
    private val nextId = AtomicInteger(1)

    private class FileState(val file: SourceIndex.SourceFile, val createdAt: Long, val prepare: ClassPrepareRequest?) {
        val breakpoints = CopyOnWriteArrayList<LineBreakpoint>()
        /** Types reported by [prepare] (i.e. loaded after it was created). */
        val preparedTypes: MutableSet<ReferenceType> = ConcurrentHashMap.newKeySet()
    }

    private val files = ConcurrentHashMap<Path, FileState>()
    private val prepareOwners = ConcurrentHashMap<EventRequest, Any>() // FileState | FunctionBreakpointState

    private class FunctionState(val bp: LineBreakpoint, val className: String?, val methodName: String, val prepare: ClassPrepareRequest?)
    private val functions = CopyOnWriteArrayList<FunctionState>()

    // ------------------------------------------------------------------ line breakpoints

    fun setLineBreakpoints(path: Path, specs: List<LineSpec>): List<LineBreakpoint> {
        val file = session.sources.info(path)
        val key = path.toAbsolutePath().normalize()
        val old = files[key]
        if (file == null) {
            old?.let { remove(key, it) }
            return specs.map { s ->
                LineBreakpoint(nextId.getAndIncrement(), null, s.line, s.condition, s.hitCondition, s.logMessage).apply {
                    message = "Cannot read source file $path"
                }
            }
        }

        // Keep breakpoints whose spec did not change (preserves hit counts and JVM requests).
        val kept = mutableListOf<LineBreakpoint>()
        val result = specs.map { s ->
            old?.breakpoints?.firstOrNull { it.sameSpec(s.line, s.condition, s.hitCondition, s.logMessage) && it !in kept }
                ?.also { kept += it }
                ?: LineBreakpoint(nextId.getAndIncrement(), file, s.line, s.condition, s.hitCondition, s.logMessage)
        }
        old?.breakpoints?.filter { it !in kept }?.forEach(::deleteRequests)

        val state = if (old != null && old.file.packageName == file.packageName) old else {
            old?.let { remove(key, it) }
            FileState(file, System.currentTimeMillis(), if (result.isEmpty()) null else createPrepareRequest(file))
                .also { st -> files[key] = st; st.prepare?.let { prepareOwners[it] = st } }
        }
        state.breakpoints.clear()
        state.breakpoints.addAll(result)
        if (result.isEmpty()) {
            remove(key, state)
            return result
        }
        val fresh = result.filter { it !in kept }
        if (fresh.isNotEmpty()) {
            // Classes loaded before the prepare request existed come from a snapshot taken after
            // it was created; later ones were delivered to it as class-prepare events.
            val types = (loadedTypesFor(file, notOlderThan = state.createdAt) + state.preparedTypes).distinct()
            Log.debug { "Binding ${fresh.size} breakpoint(s) in ${file.packageName}/${file.fileName} against ${types.size} loaded type(s): ${types.joinToString { it.name() }}" }
            for (type in types) for (bp in fresh) bind(bp, type)
            for (bp in fresh) if (!bp.verified && bp.message == null) {
                bp.message = "Pending: no loaded class contains ${file.fileName}:${bp.line} yet (it binds when the class loads)"
            }
        }
        return result
    }

    private fun remove(key: Path, state: FileState) {
        state.breakpoints.forEach(::deleteRequests)
        state.prepare?.let { prepareOwners.remove(it); safeDelete(it) }
        files.remove(key, state)
    }

    private fun createPrepareRequest(file: SourceIndex.SourceFile): ClassPrepareRequest? = try {
        erm.createClassPrepareRequest().apply {
            // Server-side filter: JDWP matches the SourceFile attribute *and* every file name in the
            // SMAP, so this also catches classes into which code from this file was inlined.
            if (vm.canUseSourceNameFilters()) addSourceNameFilter(file.fileName)
            else if (file.packageName.isNotEmpty()) addClassFilter(file.packageName + ".*")
            setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD)
            enable()
        }
    } catch (e: Exception) {
        Log.warn("Could not create class prepare request for ${file.fileName}", e); null
    }

    /** Called on the event loop. Returns true if any breakpoint was newly bound. */
    fun onClassPrepare(event: ClassPrepareEvent) {
        val type = event.referenceType()
        val owner0 = prepareOwners[event.request()]
        Log.debug { "ClassPrepare ${type.name()} owner=${owner0?.javaClass?.simpleName} sources=${Kotlin.sourceNames(type)}" }
        when (val owner = owner0) {
            is FileState -> {
                if (!matchesFile(type, owner.file)) return
                owner.preparedTypes += type
                for (bp in owner.breakpoints) {
                    val wasVerified = bp.verified
                    if (bind(bp, type) && !wasVerified) session.events.breakpointChanged(bp)
                }
            }
            is FunctionState -> {
                val wasVerified = owner.bp.verified
                if (bindFunction(owner, type) && !wasVerified) session.events.breakpointChanged(owner.bp)
            }
        }
    }

    @Volatile private var allClassesCache: Pair<Long, List<ReferenceType>>? = null

    /**
     * `allClasses()` is one large JDWP round-trip (tens of thousands of classes in a Spring app);
     * VS Code sends setBreakpoints per file in a burst, so share one snapshot for a short time.
     * Classes loaded after the snapshot are caught by the class-prepare requests.
     */
    private fun allClasses(notOlderThan: Long = System.currentTimeMillis()): List<ReferenceType> {
        val now = System.currentTimeMillis()
        allClassesCache?.let { (t, list) -> if (t >= notOlderThan && now - t < 2_000) return list }
        val list = try { vm.allClasses() } catch (e: Exception) { emptyList() }
        allClassesCache = now to list
        return list
    }

    /** Loaded classes that may hold code of [file]. */
    private fun loadedTypesFor(file: SourceIndex.SourceFile, notOlderThan: Long): List<ReferenceType> {
        val all = allClasses(notOlderThan)
        // All classes declared in a Kotlin file live in the file's package. Classes from other
        // packages only matter when this file declares inline functions (inlined call sites).
        val scanOtherPackages = declaresInlineFunctions(file.path)
        val projectPackages = session.sources.projectPackages
        return all.filter { t ->
            if (t is ArrayType) return@filter false
            val pkg = t.name().substringBeforeLast('.', "")
            val candidate = pkg == file.packageName || (scanOtherPackages && pkg in projectPackages)
            candidate && runCatching { t.isPrepared }.getOrDefault(false) && matchesFile(t, file)
        }
    }

    private fun matchesFile(type: ReferenceType, file: SourceIndex.SourceFile): Boolean =
        try { file.fileName in Kotlin.sourceNames(type) } catch (e: ObjectCollectedException) { false }

    private val inlineDecl = Regex(
        "\\binline\\s+(?:(?:public|private|internal|protected|operator|infix|suspend|override|tailrec|external|reified)\\s+)*(?:fun|val|var)\\b"
    )
    private fun declaresInlineFunctions(path: Path): Boolean =
        runCatching { inlineDecl.containsMatchIn(Files.readString(path)) }.getOrDefault(false)

    /** Creates breakpoint requests for every location of [bp]'s line in [type]. */
    private fun bind(bp: LineBreakpoint, type: ReferenceType): Boolean {
        val file = bp.file ?: return false
        val locations = locationsFor(type, file, bp.line)
        var any = false
        for (loc in locations) {
            if (!bp.markBound(loc)) { any = true; continue }
            try {
                val req = erm.createBreakpointRequest(loc).apply {
                    setSuspendPolicy(session.breakpointSuspendPolicy)
                    putProperty(BP_KEY, bp)
                    enable()
                }
                bp.requests += req
                any = true
                Log.debug { "Bound breakpoint ${file.fileName}:${bp.line} -> ${loc.declaringType().name()}.${loc.method().name()} @${loc.codeIndex()}" }
            } catch (e: Exception) {
                Log.warn("Failed to create breakpoint request at $loc", e)
            }
        }
        if (any) { bp.verified = true; bp.message = null }
        return any
    }

    private fun locationsFor(type: ReferenceType, file: SourceIndex.SourceFile, line: Int): List<Location> {
        val stratum = Kotlin.stratumOf(type)
        val raw = try {
            if (stratum != null) type.locationsOfLine(stratum, file.fileName, line) else type.locationsOfLine(line)
        } catch (e: AbsentInformationException) {
            return emptyList()
        } catch (e: ClassNotPreparedException) {
            return emptyList()
        } catch (e: ObjectCollectedException) {
            return emptyList()
        }
        // Disambiguate equally named files in different packages.
        val inPackage = raw.filter { loc ->
            val dir = Kotlin.packageDirOf(runCatching { if (stratum != null) loc.sourcePath(stratum) else loc.sourcePath() }.getOrNull())
            dir == null || dir == file.packageDir
        }
        return dropInlineReturnDuplicates(inPackage)
    }

    /**
     * One source line can own several line-table entries in a method. Some are genuine (loop
     * headers, duplicated `finally` blocks) and must all stop; others are compiler bookkeeping
     * that would make a breakpoint appear to fire twice:
     *  - after an inline function's inlined body returns, the call-site line is re-entered to
     *    store the result (the previous entry is inlined code from another file/inline level);
     *  - inside an inline body, the line re-appears after an inline *lambda* body ran;
     *  - in a coroutine state machine, the call line re-appears on the resume path right after
     *    the dispatch code, which Kotlin attributes to the function's declaration line.
     * A repeat entry is kept only when the preceding entry is ordinary code of the same file and
     * inline level on a different line.
     */
    private fun dropInlineReturnDuplicates(locations: List<Location>): List<Location> {
        if (locations.size < 2) return locations
        val out = mutableListOf<Location>()
        for ((method, locs) in locations.groupBy { it.method() }) {
            if (locs.size == 1) { out += locs; continue }
            val table = try { method.allLineLocations() } catch (e: Exception) { out += locs; continue }
            val stateMachine = Kotlin.isSuspendFunction(method) || Kotlin.isInvokeSuspend(method)
            val declarationLine = table.firstOrNull()?.let { Kotlin.sourcePos(it)?.line }
            val sorted = locs.sortedBy { it.codeIndex() }
            out += sorted.first()
            for (loc in sorted.drop(1)) {
                val prev = table.lastOrNull { it.codeIndex() < loc.codeIndex() } ?: continue
                val prevPos = Kotlin.sourcePos(prev)
                val pos = Kotlin.sourcePos(loc)
                val genuine = prevPos != null && pos != null &&
                    prevPos.sourceName == pos.sourceName && prevPos.line != pos.line &&
                    Kotlin.isInlinedBody(prev) == Kotlin.isInlinedBody(loc) &&
                    !(stateMachine && prevPos.line == declarationLine)
                if (genuine) out += loc
            }
        }
        return out
    }

    private fun deleteRequests(bp: LineBreakpoint) {
        bp.requests.forEach(::safeDelete)
        bp.requests.clear()
    }

    private fun safeDelete(r: EventRequest) {
        try { erm.deleteEventRequest(r) } catch (_: Exception) {}
    }

    // ------------------------------------------------------------------ function breakpoints

    /** Names like `com.example.OrderService.placeOrder`, `OrderService.placeOrder`, `OrderService::placeOrder`. */
    fun setFunctionBreakpoints(specs: List<Pair<String, String?>>): List<LineBreakpoint> {
        functions.forEach { f -> deleteRequests(f.bp); f.prepare?.let { prepareOwners.remove(it); safeDelete(it) } }
        functions.clear()
        return specs.map { (name, condition) ->
            val normalized = name.trim().replace("::", ".")
            val className = normalized.substringBeforeLast('.', "").ifEmpty { null }
            val methodName = normalized.substringAfterLast('.')
            val bp = LineBreakpoint(nextId.getAndIncrement(), null, 0, condition, null, null, functionName = name)
            val prepare = try {
                erm.createClassPrepareRequest().apply {
                    when {
                        className == null -> {}
                        className.contains('.') -> addClassFilter(className)
                        else -> addClassFilter("*.$className")
                    }
                    setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD)
                    if (className != null) enable()
                }
            } catch (e: Exception) { null }
            val state = FunctionState(bp, className, methodName, prepare)
            prepare?.let { prepareOwners[it] = state }
            functions += state
            val loaded = allClasses().filter { matchesClass(it, className) }
            loaded.forEach { bindFunction(state, it) }
            if (!bp.verified) bp.message = if (className == null) "Use Class.method (e.g. OrderService.placeOrder)" else "Pending: class not loaded yet"
            bp
        }
    }

    private fun matchesClass(t: ReferenceType, className: String?): Boolean {
        if (className == null || t is ArrayType) return false
        val n = t.name()
        return n == className || n.endsWith(".$className") || n.endsWith("$$className")
    }

    private fun bindFunction(state: FunctionState, type: ReferenceType): Boolean {
        if (!matchesClass(type, state.className)) return false
        var any = false
        val methods = runCatching { type.methodsByName(state.methodName) }.getOrDefault(emptyList())
            .ifEmpty { runCatching { type.methodsByName(state.methodName + "\$suspendImpl") }.getOrDefault(emptyList()) }
        for (m in methods) {
            if (m.isAbstract || m.isNative || m.isBridge) continue
            val loc = m.location() ?: continue
            if (!state.bp.markBound(loc)) { any = true; continue }
            runCatching {
                state.bp.requests += erm.createBreakpointRequest(loc).apply {
                    setSuspendPolicy(session.breakpointSuspendPolicy)
                    putProperty(BP_KEY, state.bp)
                    enable()
                }
                any = true
            }
        }
        if (any) {
            state.bp.verified = true
            state.bp.message = null
            state.bp.reportedLine = runCatching { Kotlin.sourcePos(methods.first().location())?.line }.getOrNull() ?: 0
        }
        return any
    }

    // ------------------------------------------------------------------ exception breakpoints

    data class ExceptionFilter(val id: String, val condition: String?)

    @Volatile var exceptionConditions: Map<String, List<String>> = emptyMap()
        private set
    private val exceptionRequests = CopyOnWriteArrayList<ExceptionRequest>()

    fun setExceptionBreakpoints(filters: List<ExceptionFilter>) {
        exceptionRequests.forEach(::safeDelete)
        exceptionRequests.clear()
        exceptionConditions = filters.associate { f ->
            f.id to (f.condition?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList())
        }
        for (f in filters) {
            val req = when (f.id) {
                FILTER_UNCAUGHT -> erm.createExceptionRequest(null, false, true)
                FILTER_CAUGHT -> erm.createExceptionRequest(null, true, false)
                FILTER_USER_CAUGHT -> erm.createExceptionRequest(null, true, false).apply {
                    // Only exceptions *thrown* from application code (not JDK/framework internals).
                    session.config.stepFilters.filter { !it.startsWith("*") }.forEach { addClassExclusionFilter(it) }
                }
                else -> null
            } ?: continue
            req.putProperty(EXC_FILTER_KEY, f.id)
            req.setSuspendPolicy(session.breakpointSuspendPolicy)
            // JDI quirk: make sure thread state is initialised before enabling.
            runCatching { vm.allThreads() }
            req.enable()
            exceptionRequests += req
        }
    }

    fun clearAll() {
        files.forEach { (k, v) -> remove(k, v) }
        functions.forEach { deleteRequests(it.bp) }
        exceptionRequests.forEach(::safeDelete)
    }

    companion object {
        const val BP_KEY = "ktdebug.breakpoint"
        const val EXC_FILTER_KEY = "ktdebug.exceptionFilter"
        const val FILTER_UNCAUGHT = "uncaught"
        const val FILTER_CAUGHT = "caught"
        const val FILTER_USER_CAUGHT = "userCaught"
    }
}
