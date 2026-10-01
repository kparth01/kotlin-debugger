package dev.ktdebug.eval

import com.sun.jdi.ArrayReference
import com.sun.jdi.ArrayType
import com.sun.jdi.BooleanValue
import com.sun.jdi.ByteValue
import com.sun.jdi.CharValue
import com.sun.jdi.ClassType
import com.sun.jdi.DoubleValue
import com.sun.jdi.Field
import com.sun.jdi.FloatValue
import com.sun.jdi.IntegerValue
import com.sun.jdi.InterfaceType
import com.sun.jdi.LocalVariable
import com.sun.jdi.LongValue
import com.sun.jdi.Method
import com.sun.jdi.ObjectReference
import com.sun.jdi.PrimitiveValue
import com.sun.jdi.ReferenceType
import com.sun.jdi.ShortValue
import com.sun.jdi.StringReference
import com.sun.jdi.ThreadReference
import com.sun.jdi.Value
import com.sun.jdi.VirtualMachine
import dev.ktdebug.jdi.Kotlin
import dev.ktdebug.session.DebugSession
import dev.ktdebug.session.FrameRef

/**
 * Evaluates Kotlin-syntax expressions against a suspended frame using JDI (no code is compiled
 * or injected). Supports locals (Kotlin names), `this`/`this@label`, properties via fields or
 * getters, method calls with overload/boxing/default-argument handling, common Kotlin stdlib
 * extensions, indexing, arithmetic/comparison/logic, `?.`, `?:`, `!!`, `is`, `in`, `as`,
 * string templates and assignment. Lambdas, `if`/`when` and object creation are not supported.
 */
class Evaluator(private val session: DebugSession) {

    class Ctx(val thread: ThreadReference, val depth: Int, val inlineView: Boolean) {
        val vm: VirtualMachine get() = thread.virtualMachine()
        /** Re-fetched every time: method invocations invalidate StackFrame mirrors. */
        val frame get() = thread.frame(depth)
    }

    data class StaticRef(val type: ReferenceType)
    private class Found(val value: Any?)

    // ------------------------------------------------------------------ entry points

    fun evaluate(thread: ThreadReference, depth: Int, kind: FrameRef.Kind, expression: String): Value? {
        val ctx = Ctx(thread, depth, kind == FrameRef.Kind.INLINE)
        return when (val r = eval(Parser.parse(expression), ctx)) {
            is StaticRef -> throw EvalException("'${expression.trim()}' is a type (${r.type.name()}), not a value")
            else -> r as Value?
        }
    }

    fun evaluateCondition(thread: ThreadReference, expression: String): Boolean {
        val v = evaluate(thread, 0, FrameRef.Kind.REAL, expression)
        return asBoolean(v) ?: throw EvalException("Condition must be a Boolean but was ${v?.type()?.name() ?: "null"}")
    }

    /** Logpoint message: `Order {order.id} total={total}`. */
    fun interpolate(thread: ThreadReference, message: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < message.length) {
            val c = message[i]
            if (c == '\\' && i + 1 < message.length && (message[i + 1] == '{' || message[i + 1] == '}')) {
                sb.append(message[i + 1]); i += 2; continue
            }
            if (c == '{') {
                var depth = 1
                var j = i + 1
                while (j < message.length && depth > 0) {
                    if (message[j] == '{') depth++ else if (message[j] == '}') depth--
                    j++
                }
                val expr = message.substring(i + 1, j - 1)
                sb.append(try {
                    stringify(Ctx(thread, 0, false), evaluate(thread, 0, FrameRef.Kind.REAL, expr))
                } catch (e: Exception) {
                    "<${e.message}>"
                })
                i = j
                continue
            }
            sb.append(c); i++
        }
        return sb.toString()
    }

    // ------------------------------------------------------------------ core

    private fun value(e: Expr, ctx: Ctx): Value? = when (val r = eval(e, ctx)) {
        is StaticRef -> throw EvalException("${r.type.name()} is a type, not a value")
        else -> r as Value?
    }

    private fun eval(e: Expr, ctx: Ctx): Any? = when (e) {
        is Expr.Literal -> mirror(ctx, e.value)
        is Expr.Template -> mirror(ctx, e.parts.joinToString("") { p -> if (p is Expr) stringify(ctx, value(p, ctx)) else p.toString() })
        is Expr.Name -> name(e.name, ctx)
        is Expr.This -> thisRef(e.label, ctx)
        is Expr.Member -> {
            val recv = receiver(e.target, ctx)
            if (recv == null) {
                if (e.safe) null else throw EvalException("NullPointerException: ${describe(e.target)} is null")
            } else member(recv, e.name, ctx)
        }
        is Expr.Call -> call(e, ctx)
        is Expr.Index -> index(value(e.target, ctx) ?: throw EvalException("NullPointerException: ${describe(e.target)} is null"), value(e.index, ctx), ctx)
        is Expr.Unary -> unary(e.op, value(e.operand, ctx), ctx)
        is Expr.Binary -> binary(e, ctx)
        is Expr.NotNull -> value(e.operand, ctx) ?: throw EvalException("NullPointerException: ${describe(e.operand)} is null")
        is Expr.Is -> {
            val v = value(e.operand, ctx)
            mirror(ctx, (v != null && typeMatches(v, e.type)) != e.negated)
        }
        is Expr.In -> mirror(ctx, contains(value(e.container, ctx), value(e.operand, ctx), ctx) != e.negated)
        is Expr.As -> {
            val v = value(e.operand, ctx)
            if (v == null || typeMatches(v, e.type)) v
            else if (e.safe) null
            else throw EvalException("ClassCastException: ${v.type().name()} cannot be cast to ${e.type}")
        }
        is Expr.Assign -> assign(e, ctx)
    }

    /** Evaluates a receiver; a dotted chain that is not a value may name a class (`com.x.Foo`). */
    private fun receiver(target: Expr, ctx: Ctx): Any? = try {
        eval(target, ctx)
    } catch (ex: EvalException) {
        qualifiedName(target)?.let { resolveType(it, ctx) }?.let { StaticRef(it) } ?: throw ex
    }

    private fun qualifiedName(e: Expr): String? = when (e) {
        is Expr.Name -> e.name
        is Expr.Member -> qualifiedName(e.target)?.let { "$it.${e.name}" }
        else -> null
    }

    private fun describe(e: Expr): String = qualifiedName(e) ?: when (e) {
        is Expr.Call -> "${e.name}(...)"
        is Expr.This -> "this"
        else -> "expression"
    }

    // ------------------------------------------------------------------ names

    private fun name(n: String, ctx: Ctx): Any? {
        local(n, ctx)?.let { return it.value }
        val frame = ctx.frame
        val self = frame.thisObject()
        if (self != null) {
            field(self, "$$n")?.let { return it.value }          // captured variable in lambda/anonymous object
            memberOrNull(self, n, ctx)?.let { return it.value }
            var outer: ObjectReference? = field(self, "this\$0")?.value as? ObjectReference
            var guard = 0
            while (outer != null && guard++ < 8) {
                memberOrNull(outer, n, ctx)?.let { return it.value }
                outer = field(outer, "this\$0")?.value as? ObjectReference
            }
        } else {
            // Extension function: implicit receiver is the `$this$<fun>` local.
            Kotlin.visibleLocalsSafe(frame).firstOrNull { it.name().startsWith("\$this\$") }?.let { lv ->
                (frame.getValue(lv) as? ObjectReference)?.let { recv -> memberOrNull(recv, n, ctx)?.let { return it.value } }
            }
        }
        val type = frame.location().declaringType()
        staticMember(type, n, ctx)?.let { return it.value }
        outerTypes(type, ctx).forEach { t -> staticMember(t, n, ctx)?.let { return it.value } }
        resolveType(n, ctx)?.let { return StaticRef(it) }
        throw EvalException("Unknown name '$n'")
    }

    private fun local(n: String, ctx: Ctx): Found? {
        val frame = ctx.frame
        val vars = Kotlin.visibleLocalsSafe(frame)
        val matches = vars.filter { lv ->
            val raw = lv.name()
            raw == n || (!Kotlin.isHiddenLocal(raw) && Kotlin.displayName(raw) == n)
        }
        if (matches.isEmpty()) return null
        val best = if (ctx.inlineView) matches.maxByOrNull { Kotlin.inlineDepth(it.name()) }!!
        else matches.firstOrNull { Kotlin.inlineDepth(it.name()) == 0 && it.name() == n }
            ?: matches.minByOrNull { Kotlin.inlineDepth(it.name()) }!!
        return Found(frame.getValue(best))
    }

    private fun thisRef(label: String?, ctx: Ctx): Any? {
        val frame = ctx.frame
        if (label == null) {
            frame.thisObject()?.let { return it }
            Kotlin.visibleLocalsSafe(frame).firstOrNull { it.name().startsWith("\$this\$") }?.let { return frame.getValue(it) }
            throw EvalException("'this' is not available in a static context")
        }
        Kotlin.visibleLocalsSafe(frame).firstOrNull { Kotlin.displayName(it.name()) == "this@$label" }?.let { return frame.getValue(it) }
        var obj: ObjectReference? = frame.thisObject()
        var guard = 0
        while (obj != null && guard++ < 10) {
            val simple = obj.referenceType().name().substringAfterLast('.').substringAfterLast('$')
            if (simple == label) return obj
            obj = field(obj, "this\$0")?.value as? ObjectReference
        }
        throw EvalException("Unknown label 'this@$label'")
    }

    private fun outerTypes(type: ReferenceType, ctx: Ctx): List<ReferenceType> {
        val name = type.name()
        val out = mutableListOf<ReferenceType>()
        var n = name
        while (n.contains('$')) {
            n = n.substringBeforeLast('$')
            ctx.vm.classesByName(n).firstOrNull()?.let { out += it }
        }
        return out
    }

    // ------------------------------------------------------------------ members

    private fun field(obj: ObjectReference, name: String): Found? {
        val f = obj.referenceType().fieldByName(name) ?: return null
        return Found(if (f.isStatic) obj.referenceType().getValue(f) else obj.getValue(f))
    }

    private fun member(recv: Any, name: String, ctx: Ctx): Any? {
        if (recv is StaticRef) {
            staticMember(recv.type, name, ctx)?.let { return it.value }
            ctx.vm.classesByName(recv.type.name() + "$" + name).firstOrNull()?.let { return StaticRef(it) }
            throw EvalException("Unknown member '$name' of ${recv.type.name()}")
        }
        val v = recv as Value
        memberOrNull(v, name, ctx)?.let { return it.value }
        // Kotlin extension property: `val Order.itemCount` -> static getItemCount(Order) on a facade
        extensionCall(v, "get" + name.replaceFirstChar { it.uppercaseChar() }, emptyList(), ctx)?.let { return it.value }
        throw EvalException("Unknown property '$name' on ${Kotlin.typeDisplayName(v.type().name())}")
    }

    private fun memberOrNull(recv: Value, name: String, ctx: Ctx): Found? {
        when (recv) {
            is ArrayReference -> return when (name) {
                "size", "length" -> Found(ctx.vm.mirrorOf(recv.length()))
                "lastIndex" -> Found(ctx.vm.mirrorOf(recv.length() - 1))
                else -> null
            }
            is StringReference -> return when (name) {
                "length" -> Found(ctx.vm.mirrorOf(recv.value().length))
                "lastIndex" -> Found(ctx.vm.mirrorOf(recv.value().length - 1))
                else -> null
            }
            is PrimitiveValue -> return null
            is ObjectReference -> {
                field(recv, name)?.let { return it }
                val type = recv.referenceType()
                val cap = name.replaceFirstChar { it.uppercaseChar() }
                val getter = findNoArg(type, "get$cap") ?: (if (name.startsWith("is")) findNoArg(type, name) else null)
                if (getter != null) return Found(session.invoke(ctx.thread, recv, getter, emptyList()))
                val special = when (name) {
                    "size" -> if (session.values.isCollection(type) || session.values.isMap(type)) "size" else null
                    "length" -> if (implements(type, "java.lang.CharSequence")) "length" else null
                    "keys" -> if (session.values.isMap(type)) "keySet" else null
                    "values" -> if (session.values.isMap(type)) "values" else null
                    "entries" -> if (session.values.isMap(type)) "entrySet" else null
                    else -> null
                }
                if (special != null) findNoArg(type, special)?.let { return Found(session.invoke(ctx.thread, recv, it, emptyList())) }
                // Kotlin object / companion accessed through an instance
                return null
            }
            else -> return null
        }
    }

    private fun staticMember(type: ReferenceType, name: String, ctx: Ctx): Found? {
        type.fieldByName(name)?.takeIf { it.isStatic }?.let { return Found(type.getValue(it)) }
        val cap = name.replaceFirstChar { it.uppercaseChar() }
        type.methodsByName("get$cap").firstOrNull { it.isStatic && it.argumentTypeNames().isEmpty() }?.let {
            return Found(invokeStatic(ctx, type, it, emptyList()))
        }
        // Kotlin `object` / companion
        for (holder in listOf("INSTANCE", "Companion")) {
            val f = type.fieldByName(holder)?.takeIf { it.isStatic } ?: continue
            val obj = type.getValue(f) as? ObjectReference ?: continue
            if (obj.referenceType() == type && holder == "Companion") continue
            memberOrNull(obj, name, ctx)?.let { return it }
        }
        return null
    }

    private fun findNoArg(type: ReferenceType, name: String): Method? =
        type.methodsByName(name).firstOrNull { !it.isStatic && it.argumentTypeNames().isEmpty() && !it.isAbstract }
            ?: type.methodsByName(name).firstOrNull { !it.isStatic && it.argumentTypeNames().isEmpty() }

    private fun implements(type: ReferenceType, iface: String): Boolean = when (type) {
        is ClassType -> type.name() == iface || type.allInterfaces().any { it.name() == iface }
        is InterfaceType -> type.name() == iface || type.superinterfaces().any { implements(it, iface) }
        else -> false
    }

    // ------------------------------------------------------------------ calls

    private fun call(e: Expr.Call, ctx: Ctx): Any? {
        if (e.target == null) return unqualifiedCall(e, ctx)
        val recv = receiver(e.target, ctx)
        if (recv == null) {
            if (e.safe) return null
            if (e.name == "toString") return mirror(ctx, "null")
            throw EvalException("NullPointerException: ${describe(e.target)} is null")
        }
        val args = e.args.map { value(it, ctx) }
        if (recv is StaticRef) {
            val t = recv.type
            t.methodsByName(e.name).filter { it.isStatic }.takeIf { it.isNotEmpty() }?.let { return invokeBest(ctx, t, it, args, e.name) }
            for (holder in listOf("INSTANCE", "Companion")) {
                val obj = t.fieldByName(holder)?.takeIf { it.isStatic }?.let { t.getValue(it) } as? ObjectReference ?: continue
                instanceCall(obj, e.name, args, ctx)?.let { return it.value }
            }
            throw EvalException("Unknown function '${e.name}' on ${t.name()}")
        }
        val v = recv as Value
        builtinCall(v, e.name, args, ctx)?.let { return it.value }
        if (v is ObjectReference) instanceCall(v, e.name, args, ctx)?.let { return it.value }
        extensionCall(v, e.name, args, ctx)?.let { return it.value }
        throw EvalException("Unknown function '${e.name}' for ${Kotlin.typeDisplayName(v.type().name())} with ${args.size} argument(s)")
    }

    private fun unqualifiedCall(e: Expr.Call, ctx: Ctx): Any? {
        val args = e.args.map { value(it, ctx) }
        val frame = ctx.frame
        frame.thisObject()?.let { self -> instanceCall(self, e.name, args, ctx)?.let { return it.value } }
        Kotlin.visibleLocalsSafe(ctx.frame).firstOrNull { it.name().startsWith("\$this\$") }?.let { lv ->
            (ctx.frame.getValue(lv) as? ObjectReference)?.let { r -> instanceCall(r, e.name, args, ctx)?.let { return it.value } }
        }
        val type = ctx.frame.location().declaringType()
        (listOf(type) + outerTypes(type, ctx)).forEach { t ->
            val statics = t.methodsByName(e.name).filter { it.isStatic }
            if (statics.isNotEmpty()) tryInvoke(ctx, t, statics, args)?.let { return it.value }
        }
        // top-level functions in the same package (file facades `FooKt`)
        val pkg = type.name().substringBeforeLast('.', "")
        for (facade in facadesInPackage(pkg, ctx)) {
            val statics = facade.methodsByName(e.name).filter { it.isStatic }
            if (statics.isNotEmpty()) tryInvoke(ctx, facade, statics, args)?.let { return it.value }
        }
        throw EvalException("Unknown function '${e.name}'")
    }

    private fun instanceCall(obj: ObjectReference, name: String, args: List<Value?>, ctx: Ctx): Found? {
        val type = obj.referenceType()
        val methods = type.methodsByName(name).filter { !it.isStatic }
        if (methods.isNotEmpty()) tryInvoke(ctx, obj, methods, args)?.let { return it }
        // Kotlin default arguments: static `name$default(this, args..., mask, marker)`
        val defaults = type.methodsByName("$name\$default").filter { it.isStatic }
        for (m in defaults) callWithDefaults(ctx, type, m, listOf(obj), args)?.let { return it }
        return null
    }

    /** Kotlin stdlib / project extension functions compiled as static methods on file facades. */
    private fun extensionCall(recv: Value, name: String, args: List<Value?>, ctx: Ctx): Found? {
        val facades = mutableListOf<ReferenceType>()
        val type = recv.type()
        fun add(n: String) = (ctx.vm.classesByName(n).firstOrNull() ?: loadClass(ctx, n))?.let { facades += it }
        when {
            recv is StringReference || (type is ReferenceType && implements(type, "java.lang.CharSequence")) -> add("kotlin.text.StringsKt")
            type is ArrayType -> add("kotlin.collections.ArraysKt")
            type is ReferenceType && session.values.isMap(type) -> add("kotlin.collections.MapsKt")
            type is ReferenceType && implements(type, "java.lang.Iterable") -> { add("kotlin.collections.CollectionsKt"); add("kotlin.collections.SetsKt") }
        }
        facades += projectFacadesDeclaring(name, ctx)
        for (f in facades.distinct()) {
            val statics = f.methodsByName(name).filter { it.isStatic }
            if (statics.isNotEmpty()) tryInvoke(ctx, f, statics, listOf(recv) + args)?.let { return it }
            for (m in f.methodsByName("$name\$default").filter { it.isStatic }) {
                callWithDefaults(ctx, f, m, listOf(recv), args)?.let { return it }
            }
        }
        return null
    }

    /**
     * Loads (and initializes) a class in the debuggee via `Class.forName(name, true, loader)`
     * using the class loader of the current frame, e.g. a Kotlin stdlib facade the app has not
     * touched yet. Returns null when that is not possible.
     */
    private fun loadClass(ctx: Ctx, name: String): ReferenceType? = try {
        val classType = ctx.vm.classesByName("java.lang.Class").firstOrNull() as? ClassType
        val forName = classType?.concreteMethodByName("forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;")
        if (classType == null || forName == null || !session.isStoppedByEvent(ctx.thread)) null
        else {
            val loader = ctx.frame.location().declaringType().classLoader()
            val result = session.invoke(ctx.thread, classType, forName, listOf(mirror(ctx, name), ctx.vm.mirrorOf(true), loader))
            (result as? com.sun.jdi.ClassObjectReference)?.reflectedType()
        }
    } catch (e: Exception) {
        null
    }

    /**
     * File facades (`FooKt`) of project files that mention [jvmName]'s Kotlin name, loading them in
     * the debuggee if the app has not touched them yet. Same-package files come first.
     */
    private fun projectFacadesDeclaring(jvmName: String, ctx: Ctx): List<ReferenceType> {
        val kotlinName = when {
            jvmName.startsWith("get") && jvmName.length > 3 -> jvmName.substring(3).replaceFirstChar { it.lowercaseChar() }
            else -> jvmName.removeSuffix("\$default")
        }
        val pkg = runCatching { ctx.frame.location().declaringType().name().substringBeforeLast('.', "") }.getOrDefault("")
        return session.sources.kotlinFiles()
            .filter { session.sources.fileMentions(it, kotlinName) }
            .sortedBy { if (it.packageName == pkg) 0 else 1 }
            .mapNotNull { f -> ctx.vm.classesByName(f.facadeClass).firstOrNull() ?: loadClass(ctx, f.facadeClass) }
    }

    private fun facadesInPackage(pkg: String, ctx: Ctx): List<ReferenceType> =
        session.sources.kotlinFiles().filter { it.packageName == pkg }
            .mapNotNull { f -> ctx.vm.classesByName(f.facadeClass).firstOrNull() }

    /** Operations computed locally (no debuggee code runs) for primitives and strings. */
    private fun builtinCall(v: Value, name: String, args: List<Value?>, ctx: Ctx): Found? {
        val k = toKotlin(v)
        if (k is Number || k is Char || k is Boolean) {
            val r: Any? = when (name) {
                "toInt" -> numberOf(k).toInt()
                "toLong" -> numberOf(k).toLong()
                "toDouble" -> numberOf(k).toDouble()
                "toFloat" -> numberOf(k).toFloat()
                "toShort" -> numberOf(k).toShort()
                "toByte" -> numberOf(k).toByte()
                "toChar" -> numberOf(k).toInt().toChar()
                "toString" -> k.toString()
                "hashCode" -> k.hashCode()
                "equals" -> args.size == 1 && kEquals(ctx, v, args[0])
                "compareTo" -> if (args.size == 1) compare(k, toKotlin(args[0])) else return null
                else -> return null
            }
            return Found(mirror(ctx, r))
        }
        if (v is StringReference) {
            val s = v.value()
            fun strArg(i: Int) = (args.getOrNull(i) as? StringReference)?.value() ?: toKotlin(args.getOrNull(i))?.toString() ?: "null"
            val r: Any? = when {
                name == "isEmpty" && args.isEmpty() -> s.isEmpty()
                name == "isNotEmpty" && args.isEmpty() -> s.isNotEmpty()
                name == "isBlank" && args.isEmpty() -> s.isBlank()
                name == "isNotBlank" && args.isEmpty() -> s.isNotBlank()
                name == "uppercase" && args.isEmpty() -> s.uppercase()
                name == "lowercase" && args.isEmpty() -> s.lowercase()
                name == "trim" && args.isEmpty() -> s.trim()
                name == "toString" && args.isEmpty() -> s
                name == "length" && args.isEmpty() -> s.length
                name == "startsWith" && args.size == 1 -> s.startsWith(strArg(0))
                name == "endsWith" && args.size == 1 -> s.endsWith(strArg(0))
                name == "contains" && args.size == 1 -> s.contains(strArg(0))
                name == "toInt" && args.isEmpty() -> s.toIntOrNull() ?: throw EvalException("NumberFormatException: \"$s\"")
                name == "toLong" && args.isEmpty() -> s.toLongOrNull() ?: throw EvalException("NumberFormatException: \"$s\"")
                name == "toIntOrNull" && args.isEmpty() -> s.toIntOrNull()
                name == "substring" && args.size in 1..2 -> {
                    val a = numberOf(toKotlin(args[0])).toInt()
                    if (args.size == 1) s.substring(a) else s.substring(a, numberOf(toKotlin(args[1])).toInt())
                }
                name == "equals" && args.size == 1 -> (args[0] as? StringReference)?.value() == s
                else -> return null
            }
            return Found(mirror(ctx, r))
        }
        if (v is ObjectReference && name == "isNotEmpty" && args.isEmpty()) {
            findNoArg(v.referenceType(), "isEmpty")?.let { m ->
                return Found(mirror(ctx, asBoolean(session.invoke(ctx.thread, v, m, emptyList())) == false))
            }
        }
        if (v is ArrayReference && args.isEmpty()) when (name) {
            "isEmpty" -> return Found(mirror(ctx, v.length() == 0))
            "isNotEmpty" -> return Found(mirror(ctx, v.length() != 0))
        }
        return null
    }

    // ------------------------------------------------------------------ invocation helpers

    private fun tryInvoke(ctx: Ctx, target: Any, candidates: List<Method>, args: List<Value?>): Found? {
        val sorted = candidates.filter { it.argumentTypeNames().size == args.size }
            .sortedByDescending { m -> m.argumentTypeNames().zip(args).count { (p, a) -> a != null && a.type().name() == p } }
        for (m in sorted) {
            val converted = convertArgs(ctx, m.argumentTypeNames(), args) ?: continue
            return Found(if (m.isStatic) invokeStatic(ctx, (target as? ReferenceType) ?: m.declaringType(), m, converted)
            else session.invoke(ctx.thread, target, m, converted))
        }
        return null
    }

    private fun invokeBest(ctx: Ctx, target: Any, candidates: List<Method>, args: List<Value?>, name: String): Value? {
        tryInvoke(ctx, target, candidates, args)?.let { return it.value as Value? }
        throw EvalException(
            if (candidates.any { it.argumentTypeNames().size == args.size }) "Arguments do not match any overload of '$name'"
            else "No overload of '$name' takes ${args.size} argument(s)"
        )
    }

    private fun invokeStatic(ctx: Ctx, type: ReferenceType, m: Method, args: List<Value?>): Value? = when (type) {
        is ClassType -> session.invoke(ctx.thread, type, m, args)
        is InterfaceType -> session.invoke(ctx.thread, type, m, args)
        else -> throw EvalException("Cannot call static method on ${type.name()}")
    }

    /** Calls a `$default` synthetic: leading receivers, value args, defaults mask, marker. */
    private fun callWithDefaults(ctx: Ctx, owner: ReferenceType, m: Method, leading: List<Value?>, args: List<Value?>): Found? {
        val params = m.argumentTypeNames()
        val declared = params.size - leading.size - 2   // one mask int (<= 32 params) + marker
        if (declared < args.size || declared <= 0 || params[params.size - 2] != "int") return null
        val valueParams = params.subList(leading.size, leading.size + declared)
        var mask = 0
        val all = ArrayList<Value?>(args)
        for (i in args.size until declared) {
            mask = mask or (1 shl i)
            all += zeroOf(ctx, valueParams[i])
        }
        val converted = convertArgs(ctx, params, leading + all + listOf(ctx.vm.mirrorOf(mask), null)) ?: return null
        return Found(invokeStatic(ctx, owner, m, converted))
    }

    private fun zeroOf(ctx: Ctx, typeName: String): Value? = when (typeName) {
        "int" -> ctx.vm.mirrorOf(0); "long" -> ctx.vm.mirrorOf(0L); "double" -> ctx.vm.mirrorOf(0.0)
        "float" -> ctx.vm.mirrorOf(0f); "boolean" -> ctx.vm.mirrorOf(false); "char" -> ctx.vm.mirrorOf(0.toChar())
        "short" -> ctx.vm.mirrorOf(0.toShort()); "byte" -> ctx.vm.mirrorOf(0.toByte())
        else -> null
    }

    private fun convertArgs(ctx: Ctx, params: List<String>, args: List<Value?>): List<Value?>? {
        if (params.size != args.size) return null
        return params.zip(args).map { (p, a) -> convertArg(ctx, p, a) ?: if (a == null && p !in PRIMITIVES) null else return null }
    }

    private fun convertArg(ctx: Ctx, param: String, arg: Value?): Value? {
        if (arg == null) return null
        if (param in PRIMITIVES) {
            val k = toKotlin(arg) ?: return null
            if (k !is Number && k !is Char && k !is Boolean) return null
            return primitiveMirror(ctx, param, k)
        }
        if (arg is PrimitiveValue) {
            val wrapper = when (param) {
                in WRAPPER_TO_PRIMITIVE -> param
                "java.lang.Object", "java.lang.Number", "java.lang.Comparable", "java.io.Serializable" -> wrapperOf(arg)
                else -> return null
            }
            return box(ctx, toKotlin(arg)!!, wrapper)
        }
        if (param == "java.lang.Object") return arg
        val t = arg.type()
        return if (t is ReferenceType && isAssignable(t, param)) arg else null
    }

    private fun isAssignable(t: ReferenceType, name: String): Boolean = when (t) {
        is ClassType -> generateSequence(t) { it.superclass() }.any { it.name() == name } || t.allInterfaces().any { it.name() == name }
        is InterfaceType -> implements(t, name)
        is ArrayType -> t.name() == name || name == "java.lang.Object"
        else -> false
    }

    private fun box(ctx: Ctx, k: Any, wrapper: String): Value? {
        val prim = WRAPPER_TO_PRIMITIVE[wrapper] ?: return null
        val type = ctx.vm.classesByName(wrapper).firstOrNull() as? ClassType ?: return null
        val sig = "(${JNI[prim]})L${wrapper.replace('.', '/')};"
        val valueOf = type.concreteMethodByName("valueOf", sig) ?: return null
        return session.invoke(ctx.thread, type, valueOf, listOf(primitiveMirror(ctx, prim, k)))
    }

    private fun wrapperOf(v: PrimitiveValue): String = when (v) {
        is IntegerValue -> "java.lang.Integer"; is LongValue -> "java.lang.Long"; is DoubleValue -> "java.lang.Double"
        is FloatValue -> "java.lang.Float"; is BooleanValue -> "java.lang.Boolean"; is CharValue -> "java.lang.Character"
        is ShortValue -> "java.lang.Short"; is ByteValue -> "java.lang.Byte"
        else -> "java.lang.Object"
    }

    private fun primitiveMirror(ctx: Ctx, prim: String, k: Any): Value {
        val vm = ctx.vm
        if (prim == "boolean") return vm.mirrorOf(k as? Boolean ?: throw EvalException("Expected Boolean"))
        if (prim == "char") return vm.mirrorOf(if (k is Char) k else numberOf(k).toInt().toChar())
        val n = numberOf(k)
        return when (prim) {
            "int" -> vm.mirrorOf(n.toInt()); "long" -> vm.mirrorOf(n.toLong()); "double" -> vm.mirrorOf(n.toDouble())
            "float" -> vm.mirrorOf(n.toFloat()); "short" -> vm.mirrorOf(n.toShort()); "byte" -> vm.mirrorOf(n.toByte())
            else -> throw EvalException("Unsupported primitive $prim")
        }
    }

    // ------------------------------------------------------------------ operators

    private fun unary(op: String, v: Value?, ctx: Ctx): Value? {
        val k = toKotlin(v)
        return when (op) {
            "!" -> mirror(ctx, !(k as? Boolean ?: throw EvalException("'!' needs a Boolean")))
            "-" -> mirror(ctx, when (k) {
                is Int -> -k; is Long -> -k; is Double -> -k; is Float -> -k; is Short -> -k; is Byte -> -k
                else -> throw EvalException("'-' needs a number")
            })
            else -> throw EvalException("Unsupported operator $op")
        }
    }

    private fun binary(e: Expr.Binary, ctx: Ctx): Value? {
        when (e.op) {
            "&&" -> return mirror(ctx, asBoolean(value(e.left, ctx)) == true && asBoolean(value(e.right, ctx)) == true)
            "||" -> return mirror(ctx, asBoolean(value(e.left, ctx)) == true || asBoolean(value(e.right, ctx)) == true)
            "?:" -> return value(e.left, ctx) ?: value(e.right, ctx)
        }
        val l = value(e.left, ctx)
        val r = value(e.right, ctx)
        return when (e.op) {
            "==" -> mirror(ctx, kEquals(ctx, l, r))
            "!=" -> mirror(ctx, !kEquals(ctx, l, r))
            "===" -> mirror(ctx, identical(l, r))
            "!==" -> mirror(ctx, !identical(l, r))
            "<", ">", "<=", ">=" -> {
                val c = compareValues(ctx, l, r)
                mirror(ctx, when (e.op) { "<" -> c < 0; ">" -> c > 0; "<=" -> c <= 0; else -> c >= 0 })
            }
            "+" -> if (l is StringReference || r is StringReference) mirror(ctx, stringify(ctx, l) + stringify(ctx, r))
                else arithmetic("+", l, r, ctx)
            "-", "*", "/", "%" -> arithmetic(e.op, l, r, ctx)
            else -> throw EvalException("Unsupported operator ${e.op}")
        }
    }

    private fun arithmetic(op: String, l: Value?, r: Value?, ctx: Ctx): Value? {
        val a = toKotlin(l)
        val b = toKotlin(r)
        if (a is Char && b is Int && op in setOf("+", "-")) return mirror(ctx, if (op == "+") a + b else a - b)
        if (a !is Number && a !is Char || b !is Number && b !is Char) {
            throw EvalException("Operator '$op' needs numbers (got ${l?.type()?.name() ?: "null"} and ${r?.type()?.name() ?: "null"})")
        }
        val x = numberOf(a); val y = numberOf(b)
        val result: Any = when {
            x is Double || y is Double -> calc(op, x.toDouble(), y.toDouble())
            x is Float || y is Float -> calc(op, x.toFloat().toDouble(), y.toFloat().toDouble()).toFloat()
            x is Long || y is Long -> calcLong(op, x.toLong(), y.toLong())
            else -> calcLong(op, x.toLong(), y.toLong()).toInt()
        }
        return mirror(ctx, result)
    }

    private fun calc(op: String, a: Double, b: Double): Double = when (op) {
        "+" -> a + b; "-" -> a - b; "*" -> a * b; "/" -> a / b; else -> a % b
    }

    private fun calcLong(op: String, a: Long, b: Long): Long = when (op) {
        "+" -> a + b; "-" -> a - b; "*" -> a * b
        "/" -> if (b == 0L) throw EvalException("ArithmeticException: / by zero") else a / b
        else -> if (b == 0L) throw EvalException("ArithmeticException: / by zero") else a % b
    }

    private fun compareValues(ctx: Ctx, l: Value?, r: Value?): Int {
        val a = toKotlin(l); val b = toKotlin(r)
        if ((a is Number || a is Char) && (b is Number || b is Char)) return compare(a, b)
        if (l is StringReference && r is StringReference) return l.value().compareTo(r.value())
        if (l is ObjectReference) {
            val m = l.referenceType().methodsByName("compareTo").firstOrNull { it.argumentTypeNames().size == 1 && !it.isStatic }
                ?: throw EvalException("${l.type().name()} is not Comparable")
            val res = session.invoke(ctx.thread, l, m, listOf(convertArg(ctx, m.argumentTypeNames()[0], r) ?: r))
            return (toKotlin(res) as? Int) ?: 0
        }
        throw EvalException("Cannot compare ${l?.type()?.name() ?: "null"} with ${r?.type()?.name() ?: "null"}")
    }

    private fun compare(a: Any?, b: Any?): Int {
        val x = numberOf(a); val y = numberOf(b)
        return if (x is Double || y is Double || x is Float || y is Float) x.toDouble().compareTo(y.toDouble())
        else x.toLong().compareTo(y.toLong())
    }

    fun kEquals(ctx: Ctx, a: Value?, b: Value?): Boolean {
        if (a == null || b == null) return a == null && b == null
        val ka = toKotlin(a); val kb = toKotlin(b)
        if ((ka is Number || ka is Char || ka is Boolean) && (kb is Number || kb is Char || kb is Boolean)) {
            if (ka is Number && kb is Number) return compare(ka, kb) == 0
            return ka == kb
        }
        if (a is StringReference && b is StringReference) return a.value() == b.value()
        if (a is ObjectReference && b is ObjectReference) {
            if (a == b) return true
            val m = (a.referenceType() as? ClassType)?.concreteMethodByName("equals", "(Ljava/lang/Object;)Z") ?: return false
            if (!session.isStoppedByEvent(ctx.thread)) return false
            return asBoolean(session.invoke(ctx.thread, a, m, listOf(b))) == true
        }
        return false
    }

    private fun identical(a: Value?, b: Value?): Boolean {
        if (a == null || b == null) return a == null && b == null
        if (a is ObjectReference && b is ObjectReference) return a == b
        return toKotlin(a) == toKotlin(b)
    }

    private fun contains(container: Value?, item: Value?, ctx: Ctx): Boolean {
        when (container) {
            null -> throw EvalException("NullPointerException: container is null")
            is StringReference -> return container.value().contains(stringify(ctx, item))
            is ArrayReference -> return container.values.any { kEquals(ctx, it, item) }
            is ObjectReference -> {
                val type = container.referenceType()
                val name = if (session.values.isMap(type)) "containsKey" else "contains"
                val m = type.methodsByName(name).firstOrNull { it.argumentTypeNames() == listOf("java.lang.Object") && !it.isStatic }
                    ?: throw EvalException("${type.name()} does not support 'in'")
                return asBoolean(session.invoke(ctx.thread, container, m, listOf(convertArg(ctx, "java.lang.Object", item)))) == true
            }
            else -> throw EvalException("'in' is not supported for ${container.type().name()}")
        }
    }

    private fun index(target: Value, idx: Value?, ctx: Ctx): Value? {
        when (target) {
            is ArrayReference -> {
                val i = (toKotlin(idx) as? Number)?.toInt() ?: throw EvalException("Array index must be an Int")
                if (i < 0 || i >= target.length()) throw EvalException("ArrayIndexOutOfBoundsException: $i (size ${target.length()})")
                return target.getValue(i)
            }
            is StringReference -> {
                val i = (toKotlin(idx) as? Number)?.toInt() ?: throw EvalException("String index must be an Int")
                return mirror(ctx, target.value().getOrNull(i) ?: throw EvalException("StringIndexOutOfBoundsException: $i"))
            }
            is ObjectReference -> {
                val methods = target.referenceType().methodsByName("get").filter { !it.isStatic && it.argumentTypeNames().size == 1 }
                return tryInvoke(ctx, target, methods, listOf(idx))?.value as Value?
                    ?: throw EvalException("${target.type().name()} cannot be indexed")
            }
            else -> throw EvalException("Value cannot be indexed")
        }
    }

    // ------------------------------------------------------------------ assignment

    private fun assign(e: Expr.Assign, ctx: Ctx): Value? {
        val newValue = value(e.value, ctx)
        when (val t = e.target) {
            is Expr.Name -> {
                val frame = ctx.frame
                val lv = Kotlin.visibleLocalsSafe(frame).firstOrNull { it.name() == t.name || (!Kotlin.isHiddenLocal(it.name()) && Kotlin.displayName(it.name()) == t.name) }
                if (lv != null) {
                    val coerced = coerce(ctx, newValue, lv.typeName())
                    ctx.frame.setValue(lv, coerced)
                    return coerced
                }
                val self = frame.thisObject() ?: throw EvalException("Unknown variable '${t.name}'")
                return setField(ctx, self, t.name, newValue)
            }
            is Expr.Member -> {
                val recv = value(t.target, ctx) as? ObjectReference ?: throw EvalException("Cannot assign to a member of a non-object")
                return setField(ctx, recv, t.name, newValue)
            }
            is Expr.Index -> {
                val arr = value(t.target, ctx)
                val i = (toKotlin(value(t.index, ctx)) as? Number)?.toInt() ?: throw EvalException("Index must be an Int")
                if (arr is ArrayReference) {
                    val coerced = coerce(ctx, newValue, (arr.type() as ArrayType).componentTypeName())
                    arr.setValue(i, coerced)
                    return coerced
                }
                throw EvalException("Only array elements can be assigned by index")
            }
            else -> throw EvalException("Invalid assignment target")
        }
    }

    private fun setField(ctx: Ctx, obj: ObjectReference, name: String, v: Value?): Value? {
        val f: Field = obj.referenceType().fieldByName(name) ?: obj.referenceType().fieldByName("$$name")
            ?: throw EvalException("Unknown field '$name'")
        val coerced = coerce(ctx, v, f.typeName())
        if (f.isStatic) (obj.referenceType() as? ClassType)?.setValue(f, coerced) else obj.setValue(f, coerced)
        return coerced
    }

    /** Converts a value to a variable's declared type (numeric conversion, boxing). */
    fun coerce(ctx: Ctx, v: Value?, typeName: String): Value? {
        if (v == null) {
            if (typeName in PRIMITIVES) throw EvalException("Cannot assign null to $typeName")
            return null
        }
        return convertArg(ctx, typeName, v) ?: throw EvalException("Type mismatch: ${v.type().name()} is not $typeName")
    }

    fun coerceForSet(thread: ThreadReference, depth: Int, v: Value?, typeName: String): Value? =
        coerce(Ctx(thread, depth, false), v, typeName)

    // ------------------------------------------------------------------ conversions

    private fun mirror(ctx: Ctx, k: Any?): Value? = when (k) {
        null -> null
        is Value -> k
        is Int -> ctx.vm.mirrorOf(k); is Long -> ctx.vm.mirrorOf(k); is Double -> ctx.vm.mirrorOf(k)
        is Float -> ctx.vm.mirrorOf(k); is Boolean -> ctx.vm.mirrorOf(k); is Char -> ctx.vm.mirrorOf(k)
        is Short -> ctx.vm.mirrorOf(k); is Byte -> ctx.vm.mirrorOf(k)
        is String -> ctx.vm.mirrorOf(k).also { s -> session.pin(ctx.thread.uniqueID(), s) }
        else -> throw EvalException("Cannot represent $k in the debuggee")
    }

    /** Primitive and boxed values as Kotlin values; strings as String; other objects null. */
    private fun toKotlin(v: Value?): Any? = when (v) {
        null -> null
        is BooleanValue -> v.value(); is IntegerValue -> v.value(); is LongValue -> v.value()
        is DoubleValue -> v.value(); is FloatValue -> v.value(); is CharValue -> v.value()
        is ShortValue -> v.value(); is ByteValue -> v.value()
        is StringReference -> v.value()
        is ObjectReference -> session.values.boxedValue(v)?.let { toKotlin(it) }
        else -> null
    }

    private fun numberOf(k: Any?): Number = when (k) {
        is Number -> k
        is Char -> k.code
        else -> throw EvalException("Expected a number but was ${k?.javaClass?.simpleName ?: "null"}")
    }

    private fun asBoolean(v: Value?): Boolean? = toKotlin(v) as? Boolean

    fun stringify(ctx: Ctx, v: Value?): String = when (v) {
        null -> "null"
        is StringReference -> v.value()
        is PrimitiveValue -> toKotlin(v).toString()
        is ObjectReference -> {
            session.values.boxedValue(v)?.let { toKotlin(it).toString() } ?: run {
                val m = (v.referenceType() as? ClassType)?.concreteMethodByName("toString", "()Ljava/lang/String;")
                if (m != null && session.isStoppedByEvent(ctx.thread)) {
                    (session.invoke(ctx.thread, v, m, emptyList()) as? StringReference)?.value() ?: "null"
                } else session.values.display(v, ctx.thread)
            }
        }
        else -> v.toString()
    }

    private fun typeMatches(v: Value, typeName: String): Boolean {
        val target = KOTLIN_TYPES[typeName] ?: typeName
        if (target == "java.lang.Object") return true
        val t = v.type()
        if (v is PrimitiveValue) return wrapperOf(v) == target || target == "java.lang.Number" && v !is BooleanValue && v !is CharValue
        fun nameMatches(n: String): Boolean {
            if (n == target) return true
            val dotted = n.replace('$', '.')
            return dotted == target || dotted.endsWith(".$target")
        }
        return when (t) {
            is ClassType -> generateSequence(t) { it.superclass() }.any { nameMatches(it.name()) } || t.allInterfaces().any { nameMatches(it.name()) }
            is InterfaceType -> nameMatches(t.name())
            is ArrayType -> nameMatches(t.name()) || target == "Array"
            else -> false
        }
    }

    // ------------------------------------------------------------------ type resolution

    private fun resolveType(name: String, ctx: Ctx): ReferenceType? {
        val vm = ctx.vm
        fun lookup(n: String) = vm.classesByName(n).firstOrNull { runCatching { it.isPrepared }.getOrDefault(false) }
        KOTLIN_TYPES[name]?.let { lookup(it)?.let { t -> return t } }
        if (name.contains('.')) {
            lookup(name)?.let { return it }
            // nested classes: com.x.Outer.Inner -> com.x.Outer$Inner
            var n = name
            while (n.contains('.')) {
                n = n.substring(0, n.lastIndexOf('.')) + "$" + n.substring(n.lastIndexOf('.') + 1)
                lookup(n)?.let { return it }
            }
            return null
        }
        if (!name.first().isUpperCase()) return null
        val current = runCatching { ctx.frame.location().declaringType().name() }.getOrDefault("")
        val pkg = current.substringBeforeLast('.', "")
        val candidates = listOfNotNull(
            if (pkg.isEmpty()) name else "$pkg.$name",
            "$current$$name",
            "java.lang.$name", "kotlin.$name", "java.util.$name", "kotlin.collections.$name",
        )
        candidates.forEach { c -> lookup(c)?.let { return it } }
        val bySimple = vm.allClasses().filter { it.name().substringAfterLast('.') == name }
        return bySimple.singleOrNull()
    }

    companion object {
        private val PRIMITIVES = setOf("int", "long", "double", "float", "boolean", "char", "short", "byte")
        private val WRAPPER_TO_PRIMITIVE = mapOf(
            "java.lang.Integer" to "int", "java.lang.Long" to "long", "java.lang.Double" to "double",
            "java.lang.Float" to "float", "java.lang.Boolean" to "boolean", "java.lang.Character" to "char",
            "java.lang.Short" to "short", "java.lang.Byte" to "byte",
        )
        private val JNI = mapOf("int" to "I", "long" to "J", "double" to "D", "float" to "F", "boolean" to "Z", "char" to "C", "short" to "S", "byte" to "B")
        private val KOTLIN_TYPES = mapOf(
            "Any" to "java.lang.Object", "String" to "java.lang.String", "Int" to "java.lang.Integer",
            "Long" to "java.lang.Long", "Double" to "java.lang.Double", "Float" to "java.lang.Float",
            "Boolean" to "java.lang.Boolean", "Char" to "java.lang.Character", "Short" to "java.lang.Short",
            "Byte" to "java.lang.Byte", "Number" to "java.lang.Number", "CharSequence" to "java.lang.CharSequence",
            "Comparable" to "java.lang.Comparable", "Throwable" to "java.lang.Throwable", "Exception" to "java.lang.Exception",
            "List" to "java.util.List", "MutableList" to "java.util.List", "Set" to "java.util.Set", "MutableSet" to "java.util.Set",
            "Map" to "java.util.Map", "MutableMap" to "java.util.Map", "Collection" to "java.util.Collection",
            "MutableCollection" to "java.util.Collection", "Iterable" to "java.lang.Iterable",
        )
    }
}
