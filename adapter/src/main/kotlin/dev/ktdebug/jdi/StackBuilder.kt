package dev.ktdebug.jdi

import com.sun.jdi.ClassType
import com.sun.jdi.IntegerValue
import com.sun.jdi.Location
import com.sun.jdi.Method
import com.sun.jdi.ObjectReference
import com.sun.jdi.ReferenceType
import com.sun.jdi.StringReference
import com.sun.jdi.ThreadReference
import dev.ktdebug.eval.EvalException
import dev.ktdebug.session.DebugSession
import dev.ktdebug.session.FrameRef
import dev.ktdebug.util.Log
import java.nio.file.Path

data class FrameView(
    val id: Int,
    val name: String,
    val sourceName: String?,
    val sourcePath: Path?,
    val line: Int,
    /** DAP presentation hints: "normal", "label", "subtle". */
    val hint: String = "normal",
    val ref: FrameRef?,
)

/**
 * Builds the call stack shown to the user:
 *  - Kotlin stratum positions (correct file/line for inlined code);
 *  - a virtual frame for the innermost *inline function* when stopped inside its body, with the
 *    real frame reported at the call site (KotlinDebug stratum);
 *  - for coroutines, the logical callers ("async stack") reconstructed from the continuation chain,
 *    which the physical JVM stack no longer contains after a suspension.
 */
class StackBuilder(private val session: DebugSession) {

    fun build(thread: ThreadReference, threadId: Int): List<FrameView> {
        val uid = thread.uniqueID()
        val frames = thread.frames()
        val out = mutableListOf<FrameView>()
        var asyncInserted = false
        var afterAsync = false
        for ((depth, frame) in frames.withIndex()) {
            val loc = try { frame.location() } catch (e: Exception) { continue }
            val method = loc.method()
            val type = loc.declaringType()
            val pos = Kotlin.sourcePos(loc)
            val path = pos?.let { resolve(it) }
            val subtle = afterAsync || path == null

            if (Kotlin.isInlinedBody(loc) && pos != null) {
                // Stopped inside an inline function body that was copied into this method.
                val marker = Kotlin.visibleLocalsSafe(frame).lastOrNull { Kotlin.isInlineFunctionMarker(it.name()) }
                val inlineName = marker?.let { Kotlin.inlineFunctionName(it.name()) } ?: "inline function"
                val inlineRef = FrameRef(uid, threadId, depth, FrameRef.Kind.INLINE)
                out += FrameView(session.frames.create(uid, inlineRef), "$inlineName (inlined)", pos.sourceName, path, pos.line,
                    if (path == null) "subtle" else "normal", inlineRef)
                val hostName = runCatching { loc.sourceName(Kotlin.JAVA_STRATUM) }.getOrNull()
                val hostPath = hostName?.let { session.sources.resolve(type.name().substringBeforeLast('.', "").replace('.', '/'), it) }
                val callLine = Kotlin.callSiteLine(loc) ?: pos.line
                val realRef = FrameRef(uid, threadId, depth, FrameRef.Kind.REAL)
                out += FrameView(session.frames.create(uid, realRef), frameName(method, type), hostName, hostPath, callLine,
                    if (hostPath == null) "subtle" else "normal", realRef)
            } else {
                val ref = FrameRef(uid, threadId, depth, FrameRef.Kind.REAL)
                val hint = when {
                    Kotlin.isStepThroughMethod(method) -> "subtle"
                    subtle -> "subtle"
                    else -> "normal"
                }
                out += FrameView(session.frames.create(uid, ref), frameName(method, type), pos?.sourceName, path, pos?.line ?: 0, hint, ref)
            }

            // Coroutine boundary: invokeSuspend called by BaseContinuationImpl.resumeWith.
            if (!asyncInserted && session.config.asyncStackTraces && Kotlin.isInvokeSuspend(method)) {
                val caller = frames.getOrNull(depth + 1)?.let { runCatching { it.location().method() }.getOrNull() }
                if (caller != null && caller.name() == "resumeWith" && caller.declaringType().name() == Kotlin.BASE_CONTINUATION_IMPL) {
                    val cont = runCatching { frame.thisObject() }.getOrNull()
                    if (cont != null) {
                        val async = asyncFrames(thread, threadId, cont)
                        if (async.isNotEmpty()) {
                            out += FrameView(session.frames.create(uid, FrameRef(uid, threadId, depth, FrameRef.Kind.ASYNC)),
                                "Coroutine async stack (suspended callers)", null, null, 0, "label", null)
                            out += async
                        }
                        asyncInserted = true
                        afterAsync = true
                    }
                }
            }
        }
        return out
    }

    private fun resolve(pos: Kotlin.SourcePos): Path? =
        session.sources.resolve(Kotlin.packageDirOf(pos.sourcePath), pos.sourceName)

    /** Walks `BaseContinuationImpl.completion` and asks each continuation for its stack element. */
    private fun asyncFrames(thread: ThreadReference, threadId: Int, start: ObjectReference): List<FrameView> {
        val uid = thread.uniqueID()
        val out = mutableListOf<FrameView>()
        var cont: ObjectReference? = completionOf(start)
        var guard = 0
        while (cont != null && guard++ < 64) {
            val type = cont.referenceType()
            if (!Kotlin.isSubclassOf(type, Kotlin.BASE_CONTINUATION_IMPL)) {
                out += FrameView(session.frames.create(uid, FrameRef(uid, threadId, 0, FrameRef.Kind.ASYNC, cont)),
                    "coroutine ${coroutineLabel(cont, thread)}", null, null, 0, "label", null)
                break
            }
            session.pin(uid, cont)
            val element = stackElement(cont, thread)
            val ref = FrameRef(uid, threadId, 0, FrameRef.Kind.ASYNC, cont)
            if (element != null) {
                val (cls, methodName, file, line) = element
                val path = file?.let { session.sources.resolve(cls.substringBeforeLast('.', "").replace('.', '/'), it) }
                out += FrameView(session.frames.create(uid, ref), prettyName(cls, methodName), file, path, line,
                    if (path == null) "subtle" else "normal", ref)
            } else {
                out += FrameView(session.frames.create(uid, ref), continuationName(type) + " (suspended)", null, null, 0, "subtle", ref)
            }
            cont = completionOf(cont)
        }
        return out
    }

    private fun completionOf(cont: ObjectReference): ObjectReference? {
        val t = cont.referenceType() as? ClassType ?: return null
        val f = generateSequence(t) { it.superclass() }.mapNotNull { it.fieldByName("completion") }.firstOrNull() ?: return null
        return cont.getValue(f) as? ObjectReference
    }

    private data class Element(val cls: String, val method: String, val file: String?, val line: Int)

    private fun stackElement(cont: ObjectReference, thread: ThreadReference): Element? {
        val type = cont.referenceType() as? ClassType ?: return null
        if (!session.isStoppedByEvent(thread)) return null
        val m = type.concreteMethodByName("getStackTraceElement", "()Ljava/lang/StackTraceElement;") ?: return null
        return try {
            val ste = session.invoke(thread, cont, m, emptyList()) as? ObjectReference ?: return null
            fun str(name: String) = ste.referenceType().fieldByName(name)?.let { ste.getValue(it) as? StringReference }?.value()
            val line = ste.referenceType().fieldByName("lineNumber")?.let { (ste.getValue(it) as? IntegerValue)?.value() } ?: 0
            Element(str("declaringClass") ?: return null, str("methodName") ?: "?", str("fileName"), line)
        } catch (e: EvalException) {
            Log.debug { "getStackTraceElement failed: ${e.message}" }
            null
        }
    }

    private fun coroutineLabel(coroutine: ObjectReference, thread: ThreadReference): String {
        val name = Kotlin.typeDisplayName(coroutine.referenceType().name())
        return "$name@${coroutine.uniqueID()}"
    }

    private fun continuationName(type: ReferenceType): String {
        val simple = type.name().substringAfterLast('.')
        return simple.split('$').filter { it.isNotEmpty() && !it.all(Char::isDigit) }.joinToString(".")
    }

    companion object {
        /** Human-friendly frame name: `OrderService.placeOrder`, `OrderService.placeOrder { lambda }`. */
        fun frameName(method: Method, type: ReferenceType): String = prettyName(type.name(), method.name())

        fun prettyName(className: String, rawMethod: String): String {
            // value-class mangling: `transfer-Gt7mH5k` -> `transfer`
            val m = if (rawMethod.contains('-') && !rawMethod.startsWith("<")) rawMethod.substringBefore('-') else rawMethod
            val simple = className.substringAfterLast('.')
            val parts = simple.split('$').filter { it.isNotEmpty() }
            val outer = parts.filter { !it.all(Char::isDigit) }.joinToString(".")
            val isNumbered = parts.lastOrNull()?.all(Char::isDigit) == true
            return when {
                simple.contains("\$\$Lambda") -> "${parts.first()} (lambda proxy)"
                simple.contains("\$\$SpringCGLIB\$\$") || simple.contains("\$\$EnhancerBySpringCGLIB") -> "${parts.first()}.$m (Spring proxy)"
                m == "invokeSuspend" && isNumbered -> "$outer { suspend }"
                m == "invoke" && isNumbered -> "$outer { lambda }"
                m.contains("\$lambda") -> "$outer.${m.substringBefore("\$lambda")} { lambda }"
                m.endsWith("\$suspendImpl") -> "$outer.${m.removeSuffix("\$suspendImpl")}"
                m == "<init>" -> "$outer.<init>"
                else -> "$outer.$m"
            }
        }
    }
}
