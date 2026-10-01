package dev.ktdebug.jdi

import com.sun.jdi.ArrayReference
import com.sun.jdi.BooleanValue
import com.sun.jdi.ByteValue
import com.sun.jdi.CharValue
import com.sun.jdi.ClassType
import com.sun.jdi.DoubleValue
import com.sun.jdi.Field
import com.sun.jdi.FloatValue
import com.sun.jdi.IntegerValue
import com.sun.jdi.LocalVariable
import com.sun.jdi.LongValue
import com.sun.jdi.ObjectCollectedException
import com.sun.jdi.ObjectReference
import com.sun.jdi.PrimitiveValue
import com.sun.jdi.ReferenceType
import com.sun.jdi.ShortValue
import com.sun.jdi.StringReference
import com.sun.jdi.ThreadReference
import com.sun.jdi.Value
import dev.ktdebug.eval.EvalException
import dev.ktdebug.session.DebugSession
import dev.ktdebug.session.FrameRef
import dev.ktdebug.util.Log
import java.util.concurrent.ConcurrentHashMap

/** A variable as shown in the Variables view / hover / watch. */
data class VarView(
    val name: String,
    val value: String,
    val type: String?,
    val reference: Int = 0,
    val evaluateName: String? = null,
    val indexed: Int? = null,
    val named: Int? = null,
    val virtual: Boolean = false,
)

// Variable containers (targets of DAP variablesReference handles).
data class LocalsContainer(val frame: FrameRef)
data class ObjectContainer(val threadUid: Long, val obj: ObjectReference, val evaluateName: String?, val raw: Boolean = false)
data class StaticsContainer(val threadUid: Long, val type: ReferenceType)
data class ArrayContainer(val threadUid: Long, val array: ArrayReference, val evaluateName: String?, val elementEvalNames: Boolean = true)
data class MapContainer(val threadUid: Long, val map: ObjectReference, val evaluateName: String?)
data class EntryContainer(val threadUid: Long, val key: Value?, val value: Value?, val evaluateName: String?)

/** Value rendering and structured children, Kotlin flavoured. */
class Values(private val session: DebugSession) {
    private val toStringCache = ConcurrentHashMap<Long, String>()
    private val interfacesCache = ConcurrentHashMap<ReferenceType, Set<String>>()

    fun clearCache() = toStringCache.clear()

    // ------------------------------------------------------------------ rendering

    fun view(
        name: String,
        value: Value?,
        thread: ThreadReference?,
        evaluateName: String?,
        declaredType: String? = null,
    ): VarView {
        val uid = thread?.uniqueID() ?: 0L
        return try {
            val (display, ref, indexed) = describe(value, thread, uid, evaluateName)
            VarView(name, display, typeName(value, declaredType), ref, evaluateName, indexed)
        } catch (e: ObjectCollectedException) {
            VarView(name, "<collected>", declaredType, 0, evaluateName)
        } catch (e: Exception) {
            Log.debug { "Failed to render $name: $e" }
            VarView(name, "<error: ${e.message ?: e.javaClass.simpleName}>", declaredType, 0, evaluateName)
        }
    }

    private fun typeName(v: Value?, declared: String?): String? = when (v) {
        null -> declared?.let { Kotlin.typeDisplayName(it) }
        else -> Kotlin.typeDisplayName(v.type().name())
    }

    /** Returns display string, children handle (0 = leaf) and indexed child count. */
    private fun describe(v: Value?, thread: ThreadReference?, uid: Long, evalName: String?): Triple<String, Int, Int?> {
        return when (v) {
            null -> Triple("null", 0, null)
            is PrimitiveValue -> Triple(primitive(v), 0, null)
            is StringReference -> Triple(quote(v.value()), 0, null)
            is ArrayReference -> {
                val len = v.length()
                val ref = if (len > 0) session.variables.create(uid, ArrayContainer(uid, v, evalName)) else 0
                Triple("${Kotlin.typeDisplayName(v.type().name())}($len)", ref, len)
            }
            is ObjectReference -> {
                val type = v.referenceType()
                val name = type.name()
                boxedValue(v)?.let { return Triple(primitive(it), 0, null) }
                if (name == "kotlin.Unit") return Triple("Unit", 0, null)
                val ref = when {
                    isMap(type) -> session.variables.create(uid, MapContainer(uid, v, evalName))
                    else -> session.variables.create(uid, ObjectContainer(uid, v, evalName))
                }
                Triple(objectDisplay(v, type, thread), ref, null)
            }
            else -> Triple(v.toString(), 0, null)
        }
    }

    fun display(v: Value?, thread: ThreadReference?): String = when (v) {
        null -> "null"
        is PrimitiveValue -> primitive(v)
        is StringReference -> quote(v.value())
        is ArrayReference -> "${Kotlin.typeDisplayName(v.type().name())}(${v.length()})"
        is ObjectReference -> boxedValue(v)?.let(::primitive) ?: objectDisplay(v, v.referenceType(), thread)
        else -> v.toString()
    }

    private fun objectDisplay(v: ObjectReference, type: ReferenceType, thread: ThreadReference?): String {
        val simple = Kotlin.typeDisplayName(type.name())
        if (type is ClassType && type.isEnum) {
            enumName(v)?.let { return "${simple}.$it" }
        }
        if (isThrowable(type)) return simple + (throwableMessage(v)?.let { ": $it" } ?: "")
        val size = if (isCollection(type) || isMap(type)) sizeOf(v, type, thread) else null
        val textual = if (size == null && thread != null && session.config.showToString && shouldCallToString(type)) {
            safeToString(v, thread)
        } else null
        return when {
            textual != null -> textual
            size != null -> "$simple(size=$size)"
            else -> "$simple@${v.uniqueID()}"
        }
    }

    private fun primitive(v: PrimitiveValue): String = when (v) {
        is CharValue -> "'" + escape(v.value().toString()) + "'"
        is BooleanValue -> v.value().toString()
        is IntegerValue -> v.value().toString()
        is LongValue -> v.value().toString()
        is DoubleValue -> v.value().toString()
        is FloatValue -> v.value().toString()
        is ShortValue -> v.value().toString()
        is ByteValue -> v.value().toString()
        else -> v.toString()
    }

    private fun quote(s: String): String {
        val limited = if (s.length > MAX_STRING) s.take(MAX_STRING) + "…" else s
        return "\"" + escape(limited) + "\""
    }

    private fun escape(s: String) = buildString {
        for (c in s) when (c) {
            '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
            '"' -> append("\\\""); '\\' -> append("\\\\")
            else -> append(c)
        }
    }

    fun boxedValue(v: ObjectReference): PrimitiveValue? {
        val name = v.referenceType().name()
        if (name !in BOXED) return null
        val f = v.referenceType().fieldByName("value") ?: return null
        return v.getValue(f) as? PrimitiveValue
    }

    private fun enumName(v: ObjectReference): String? {
        var t: ClassType? = v.referenceType() as? ClassType
        while (t != null && t.name() != "java.lang.Enum") t = t.superclass()
        val f = t?.fieldByName("name") ?: return null
        return (v.getValue(f) as? StringReference)?.value()
    }

    fun throwableMessage(ex: ObjectReference): String? = try {
        var t: ClassType? = ex.referenceType() as? ClassType
        while (t != null && t.name() != "java.lang.Throwable") t = t.superclass()
        t?.fieldByName("detailMessage")?.let { (ex.getValue(it) as? StringReference)?.value() }
    } catch (e: Exception) { null }

    private fun shouldCallToString(type: ReferenceType): Boolean {
        val ct = type as? ClassType ?: return false
        val name = ct.name()
        if (SAFE_TOSTRING_PREFIXES.any { name.startsWith(it) }) return true
        // Generated proxies (CGLIB, ByteBuddy, Hibernate lazy proxies): toString may hit the DB or throw.
        if (name.contains("\$\$") || name.contains("\$HibernateProxy\$") || name.contains("\$ByteBuddy\$")) return false
        val pkg = name.substringBeforeLast('.', "")
        if (pkg !in session.sources.projectPackages) return false
        // Lambdas/continuations print noise; only call user-defined toString implementations.
        val m = ct.concreteMethodByName("toString", "()Ljava/lang/String;") ?: return false
        return m.declaringType().name() != "java.lang.Object"
    }

    private fun safeToString(v: ObjectReference, thread: ThreadReference): String? {
        toStringCache[v.uniqueID()]?.let { return it }
        if (!session.isStoppedByEvent(thread)) return null
        val ct = v.referenceType() as? ClassType ?: return null
        val m = ct.concreteMethodByName("toString", "()Ljava/lang/String;") ?: return null
        return try {
            val s = (session.invoke(thread, v, m, emptyList()) as? StringReference)?.value() ?: return null
            val shown = if (s.length > MAX_TOSTRING) s.take(MAX_TOSTRING) + "…" else s
            toStringCache[v.uniqueID()] = shown
            shown
        } catch (e: EvalException) {
            null
        }
    }

    // ------------------------------------------------------------------ type checks

    private fun interfaces(type: ReferenceType): Set<String> = interfacesCache.computeIfAbsent(type) {
        when (it) {
            is ClassType -> it.allInterfaces().map { i -> i.name() }.toSet()
            is com.sun.jdi.InterfaceType -> (it.superinterfaces().flatMap { s -> interfaces(s) } + it.name()).toSet()
            else -> emptySet()
        }
    }

    fun isCollection(type: ReferenceType) = "java.util.Collection" in interfaces(type)
    fun isMap(type: ReferenceType) = "java.util.Map" in interfaces(type)
    fun isThrowable(type: ReferenceType) = Kotlin.isSubclassOf(type, "java.lang.Throwable")

    private fun intField(obj: ObjectReference, name: String): Int? =
        (obj.referenceType().fieldByName(name)?.let { obj.getValue(it) } as? IntegerValue)?.value()

    private fun objField(obj: ObjectReference, name: String): Value? =
        obj.referenceType().fieldByName(name)?.let { obj.getValue(it) }

    /** Collection/map size, read from fields when possible to avoid method calls. */
    fun sizeOf(v: ObjectReference, type: ReferenceType, thread: ThreadReference?): Int? {
        intField(v, "size")?.let { return it }
        (objField(v, "map") as? ObjectReference)?.let { m -> intField(m, "size")?.let { return it } } // HashSet
        (objField(v, "a") as? ArrayReference)?.let { return it.length() }                             // Arrays.asList
        (objField(v, "elements") as? ArrayReference)?.let { return it.length() }                      // List.of(...)
        if (type.name() == "kotlin.collections.EmptyList" || type.name() == "kotlin.collections.EmptySet" ||
            type.name() == "kotlin.collections.EmptyMap") return 0
        if (thread == null || !session.isStoppedByEvent(thread)) return null
        val m = (type as? ClassType)?.concreteMethodByName("size", "()I") ?: return null
        return try { (session.invoke(thread, v, m, emptyList()) as? IntegerValue)?.value() } catch (e: EvalException) { null }
    }

    // ------------------------------------------------------------------ children

    fun children(container: Any, start: Int?, count: Int?): List<VarView> = when (container) {
        is LocalsContainer -> locals(container.frame)
        is ObjectContainer -> objectChildren(container)
        is ArrayContainer -> arrayChildren(container, start ?: 0, count)
        is MapContainer -> mapChildren(container)
        is EntryContainer -> {
            val t = threadOf(container.threadUid)
            listOf(
                view("key", container.key, t, null),
                view("value", container.value, t, container.evaluateName),
            )
        }
        is StaticsContainer -> staticChildren(container)
        else -> emptyList()
    }

    private fun threadOf(uid: Long): ThreadReference? = session.threadByUid(uid)

    fun locals(ref: FrameRef): List<VarView> {
        val t = session.threadIds.thread(ref.threadId) ?: return emptyList()
        if (ref.kind == FrameRef.Kind.ASYNC) {
            val cont = ref.continuation ?: return emptyList()
            return fieldsOf(cont, t, null, includeContinuationState = true)
        }
        val frame = t.frame(ref.depth)
        val inlineView = ref.kind == FrameRef.Kind.INLINE
        val all = Kotlin.visibleLocalsSafe(frame)
        val result = LinkedHashMap<String, VarView>()

        if (!inlineView) {
            frame.thisObject()?.let { self ->
                result["this"] = view("this", self, t, "this")
                result.putAll(capturedFromThis(self, t))
            }
        }
        if (all.isEmpty()) {
            // Compiled without local variable tables: show arguments positionally.
            runCatching { frame.argumentValues }.getOrNull()?.forEachIndexed { i, v ->
                result["arg$i"] = view("arg$i", v, t, null)
            }
            return result.values.toList()
        }
        val selected = all.filter { lv ->
            val n = lv.name()
            !Kotlin.isHiddenLocal(n) && (if (inlineView) Kotlin.inlineDepth(n) >= 1 else Kotlin.inlineDepth(n) == 0)
        }
        val frameValues = runCatching { t.frame(ref.depth).getValues(selected) }.getOrDefault(emptyMap<LocalVariable, Value>())
        for (lv in selected) {
            val display = Kotlin.displayName(lv.name())
            val evalName = display.takeIf { isIdentifier(it) || it.startsWith("this@") }
            result.remove(display) // later (inner) declarations shadow earlier ones
            result[display] = view(display, frameValues[lv], t, evalName, lv.typeName())
        }
        return result.values.toList()
    }

    /** Variables captured by a lambda / anonymous object / coroutine, shown like locals. */
    private fun capturedFromThis(self: ObjectReference, t: ThreadReference): Map<String, VarView> {
        val type = self.referenceType() as? ClassType ?: return emptyMap()
        val synthetic = type.name().substringAfterLast('.').let { Regex("\\$\\d+$").containsMatchIn(it) || it.contains("\$lambda") } ||
            Kotlin.isSubclassOf(type, Kotlin.BASE_CONTINUATION_IMPL) || Kotlin.isSubclassOf(type, "kotlin.jvm.internal.Lambda")
        if (!synthetic) return emptyMap()
        val out = LinkedHashMap<String, VarView>()
        for (f in type.allFields()) {
            if (f.isStatic) continue
            val n = f.name()
            if ((n.startsWith("$") && !n.startsWith("$$")) || n == "this\$0") {
                val display = Kotlin.displayName(n)
                out[display] = view(display, self.getValue(f), t, display.takeIf { isIdentifier(it) }, f.typeName())
            }
        }
        return out
    }

    private fun objectChildren(c: ObjectContainer): List<VarView> {
        val t = threadOf(c.threadUid)
        val obj = c.obj
        val type = obj.referenceType()
        if (!c.raw && isCollection(type)) {
            val elements = collectionElements(obj, type, t)
            if (elements != null) {
                val isList = "java.util.List" in interfaces(type)
                val out = mutableListOf<VarView>()
                elements.take(MAX_LOGICAL).forEachIndexed { i, v ->
                    out += view("[$i]", v, t, if (isList && c.evaluateName != null) "${c.evaluateName}[$i]" else null)
                }
                if (elements.size > MAX_LOGICAL) out += VarView("…", "${elements.size - MAX_LOGICAL} more", null)
                out += VarView("[raw]", Kotlin.typeDisplayName(type.name()), null,
                    session.variables.create(c.threadUid, c.copy(raw = true)), null, virtual = true)
                return out
            }
        }
        val fields = fieldsOf(obj, t, c.evaluateName, includeContinuationState = false).toMutableList()
        staticNode(c.threadUid, type)?.let { fields += it }
        return fields
    }

    private fun fieldsOf(obj: ObjectReference, t: ThreadReference?, parentEval: String?, includeContinuationState: Boolean): List<VarView> {
        val type = obj.referenceType()
        val fields = type.allFields().filter { !it.isStatic }
        val vals = runCatching { obj.getValues(fields) }.getOrDefault(emptyMap<Field, Value>())
        return fields.map { f ->
            val n = f.name()
            val display = if (includeContinuationState) n else Kotlin.displayName(n)
            view(display, vals[f], t, if (parentEval != null && isIdentifier(n)) "$parentEval.$n" else null, f.typeName())
        }
    }

    private fun staticNode(uid: Long, type: ReferenceType): VarView? {
        val statics = type.allFields().filter { it.isStatic && !it.name().startsWith("$$") }
        if (statics.isEmpty()) return null
        return VarView("[static]", Kotlin.typeDisplayName(type.name()), null,
            session.variables.create(uid, StaticsContainer(uid, type)), null, virtual = true)
    }

    private fun staticChildren(c: StaticsContainer): List<VarView> {
        val t = threadOf(c.threadUid)
        val statics = c.type.allFields().filter { it.isStatic && !it.name().startsWith("$$") }
        val vals = runCatching { c.type.getValues(statics) }.getOrDefault(emptyMap<Field, Value>())
        return statics.map { f -> view(Kotlin.displayName(f.name()), vals[f], t, null, f.typeName()) }
    }

    private fun arrayChildren(c: ArrayContainer, start: Int, count: Int?): List<VarView> {
        val t = threadOf(c.threadUid)
        val len = c.array.length()
        val from = start.coerceIn(0, len)
        val n = (count ?: (len - from)).coerceAtMost(len - from).coerceAtMost(MAX_PAGE)
        if (n <= 0) return emptyList()
        val vals = c.array.getValues(from, n)
        return vals.mapIndexed { i, v ->
            val idx = from + i
            view("[$idx]", v, t, if (c.elementEvalNames && c.evaluateName != null) "${c.evaluateName}[$idx]" else null)
        }
    }

    private fun collectionElements(obj: ObjectReference, type: ReferenceType, t: ThreadReference?): List<Value?>? {
        // Field access first (no code runs in the debuggee).
        val elementData = objField(obj, "elementData") as? ArrayReference
        val size = intField(obj, "size")
        if (elementData != null && size != null && type.name() == "java.util.ArrayList") {
            return if (size == 0) emptyList() else elementData.getValues(0, size.coerceAtMost(elementData.length()))
        }
        if (type.name().startsWith("java.util.Arrays\$ArrayList")) (objField(obj, "a") as? ArrayReference)?.let { return it.values }
        if (type.name().startsWith("java.util.ImmutableCollections\$ListN")) (objField(obj, "elements") as? ArrayReference)?.let { return it.values }
        if (t == null || !session.isStoppedByEvent(t)) return null
        val toArray = (type as? ClassType)?.concreteMethodByName("toArray", "()[Ljava/lang/Object;") ?: return null
        return try {
            (session.invoke(t, obj, toArray, emptyList()) as? ArrayReference)?.values
        } catch (e: EvalException) { null }
    }

    private fun mapChildren(c: MapContainer): List<VarView> {
        val t = threadOf(c.threadUid)
        val map = c.map
        val type = map.referenceType() as? ClassType ?: return emptyList()
        val raw = VarView("[raw]", Kotlin.typeDisplayName(type.name()), null,
            session.variables.create(c.threadUid, ObjectContainer(c.threadUid, map, c.evaluateName, raw = true)), null, virtual = true)
        if (t == null || !session.isStoppedByEvent(t)) return fieldsOf(map, t, c.evaluateName, false)
        return try {
            val entrySet = type.concreteMethodByName("entrySet", "()Ljava/util/Set;") ?: return listOf(raw)
            val set = session.invoke(t, map, entrySet, emptyList()) as? ObjectReference ?: return listOf(raw)
            val toArray = (set.referenceType() as? ClassType)?.concreteMethodByName("toArray", "()[Ljava/lang/Object;") ?: return listOf(raw)
            val entries = (session.invoke(t, set, toArray, emptyList()) as? ArrayReference)?.values ?: return listOf(raw)
            val out = entries.take(MAX_LOGICAL).mapNotNull { e ->
                val entry = e as? ObjectReference ?: return@mapNotNull null
                val (k, v) = entryKeyValue(entry, t)
                val keyText = display(k, t)
                val evalName = if (c.evaluateName != null && (k is StringReference || k is PrimitiveValue)) "${c.evaluateName}[$keyText]" else null
                val valueView = view(keyText, v, t, evalName)
                if (valueView.reference != 0) valueView
                else valueView.copy(reference = session.variables.create(c.threadUid, EntryContainer(c.threadUid, k, v, evalName)))
            }.toMutableList()
            if (entries.size > MAX_LOGICAL) out += VarView("…", "${entries.size - MAX_LOGICAL} more", null)
            out + raw
        } catch (e: EvalException) {
            listOf(raw)
        }
    }

    private fun entryKeyValue(entry: ObjectReference, t: ThreadReference): Pair<Value?, Value?> {
        val type = entry.referenceType()
        val kf = type.fieldByName("key")
        val vf = type.fieldByName("value") ?: type.fieldByName("val")
        if (kf != null && vf != null) return entry.getValue(kf) to entry.getValue(vf)
        val ct = type as? ClassType ?: return null to null
        val getKey = ct.concreteMethodByName("getKey", "()Ljava/lang/Object;")
        val getValue = ct.concreteMethodByName("getValue", "()Ljava/lang/Object;")
        return (getKey?.let { session.invoke(t, entry, it, emptyList()) }) to (getValue?.let { session.invoke(t, entry, it, emptyList()) })
    }

    private fun isIdentifier(s: String) = s.isNotEmpty() && (s[0].isLetter() || s[0] == '_') && s.all { it.isLetterOrDigit() || it == '_' }

    companion object {
        private const val MAX_STRING = 10_000
        private const val MAX_TOSTRING = 500
        private const val MAX_LOGICAL = 1_000
        private const val MAX_PAGE = 1_000
        private val BOXED = setOf(
            "java.lang.Integer", "java.lang.Long", "java.lang.Short", "java.lang.Byte", "java.lang.Double",
            "java.lang.Float", "java.lang.Boolean", "java.lang.Character",
        )
        private val SAFE_TOSTRING_PREFIXES = listOf(
            "java.math.", "java.time.", "java.util.UUID", "java.util.Optional", "java.util.Locale", "java.util.Currency",
            "java.net.URI", "java.net.URL", "java.net.Inet", "java.lang.StringBuilder", "java.lang.StringBuffer",
            "java.util.concurrent.atomic.", "java.io.File", "sun.nio.fs.", "java.nio.charset.",
            "kotlin.Pair", "kotlin.Triple", "kotlin.Result", "kotlin.text.Regex", "kotlin.ranges.", "kotlin.time.",
            "java.util.regex.Pattern", "java.lang.Class",
        )
    }
}
