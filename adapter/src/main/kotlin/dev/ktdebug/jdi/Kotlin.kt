package dev.ktdebug.jdi

import com.sun.jdi.AbsentInformationException
import com.sun.jdi.ClassType
import com.sun.jdi.LocalVariable
import com.sun.jdi.Location
import com.sun.jdi.Method
import com.sun.jdi.ReferenceType

/**
 * Knowledge about how the Kotlin compiler maps source to bytecode.
 *
 * Kotlin writes a JSR-45 `SourceDebugExtension` (SMAP) into classes that contain inlined code:
 *  - stratum "Kotlin" (the default stratum) maps every bytecode line to the real source file and
 *    line, including code that was inlined from another file (whose lines get "fake" numbers past
 *    the end of the host file in the plain Java line table);
 *  - stratum "KotlinDebug" maps those fake lines back to the call site in the host file.
 * JDI understands SMAP natively, so all mapping goes through JDI's stratum-aware APIs.
 */
object Kotlin {
    const val STRATUM = "Kotlin"
    const val DEBUG_STRATUM = "KotlinDebug"
    const val JAVA_STRATUM = "Java"

    private const val INLINE_FUN_MARKER = "\$i\$f\$"
    private const val INLINE_LAMBDA_MARKER = "\$i\$a\$"
    private const val INLINED_SUFFIX = "\$iv"
    const val CONTINUATION_TYPE = "kotlin.coroutines.Continuation"
    const val BASE_CONTINUATION_IMPL = "kotlin.coroutines.jvm.internal.BaseContinuationImpl"

    fun stratumOf(type: ReferenceType): String? = try {
        if (STRATUM in type.availableStrata()) STRATUM else null
    } catch (e: Exception) { null }

    /** Source names the type contributes code for (own file plus files inlined into it). */
    fun sourceNames(type: ReferenceType): List<String> = try {
        val stratum = stratumOf(type)
        if (stratum != null) type.sourceNames(stratum) else listOf(type.sourceName())
    } catch (e: AbsentInformationException) { emptyList() } catch (e: Exception) { emptyList() }

    /**
     * Package directory ("com/example") of a location in the given stratum. Kotlin's SMAP stores
     * class internal names (e.g. "com/example/util/TimingKt") as file paths; javac-style default
     * stratum paths are "com/example/Foo.kt". Either way the directory part is the package.
     */
    fun packageDirOf(path: String?): String? = path?.replace('\\', '/')?.substringBeforeLast('/', "")

    data class SourcePos(val sourceName: String, val sourcePath: String?, val line: Int)

    /** The user-facing source position of a location (Kotlin stratum when available). */
    fun sourcePos(location: Location): SourcePos? {
        val type = location.declaringType()
        val stratum = stratumOf(type)
        return try {
            val name = if (stratum != null) location.sourceName(stratum) else location.sourceName()
            val path = runCatching { if (stratum != null) location.sourcePath(stratum) else location.sourcePath() }.getOrNull()
            val line = if (stratum != null) location.lineNumber(stratum) else location.lineNumber()
            SourcePos(name, path, line)
        } catch (e: AbsentInformationException) {
            null
        }
    }

    /**
     * True when the location executes code that the compiler inlined from an inline function's
     * body (the plain JVM line is a synthetic number and the Kotlin stratum points elsewhere).
     * Inline *lambda* bodies are not considered inlined: they belong to the caller's source.
     */
    fun isInlinedBody(location: Location): Boolean {
        val type = location.declaringType()
        if (stratumOf(type) == null) return false
        return try {
            val javaLine = location.lineNumber(JAVA_STRATUM)
            val kotlinLine = location.lineNumber(STRATUM)
            val javaName = runCatching { location.sourceName(JAVA_STRATUM) }.getOrNull()
            val kotlinName = runCatching { location.sourceName(STRATUM) }.getOrNull()
            javaLine != kotlinLine || javaName != kotlinName
        } catch (e: Exception) {
            false
        }
    }

    /** For a location inside an inlined body: the call-site line in the host file, if known. */
    fun callSiteLine(location: Location): Int? = try {
        if (DEBUG_STRATUM in location.declaringType().availableStrata()) {
            location.lineNumber(DEBUG_STRATUM).takeIf { it > 0 }
        } else null
    } catch (e: Exception) { null }

    // ---- variables -------------------------------------------------------------------------

    fun isInlineFunctionMarker(name: String) = name.startsWith(INLINE_FUN_MARKER)
    fun inlineFunctionName(marker: String) = marker.removePrefix(INLINE_FUN_MARKER)

    /** Number of inline levels a local belongs to (`x$iv$iv` -> 2). */
    fun inlineDepth(name: String): Int {
        var n = name
        var depth = 0
        while (n.endsWith(INLINED_SUFFIX)) { n = n.removeSuffix(INLINED_SUFFIX); depth++ }
        return depth
    }

    /** Compiler bookkeeping locals that should never be shown to users. */
    fun isHiddenLocal(name: String): Boolean =
        name.startsWith(INLINE_FUN_MARKER) || name.startsWith(INLINE_LAMBDA_MARKER) ||
            name == "\$completion" || name == "\$continuation" || name == "\$result" ||
            name.startsWith("\$i\$") || name.isEmpty() || name.startsWith("<")

    /** User-facing name for a compiler-mangled local or field name. */
    fun displayName(raw: String): String {
        var n = raw
        while (n.endsWith(INLINED_SUFFIX)) n = n.removeSuffix(INLINED_SUFFIX)
        return when {
            n.startsWith("\$this\$") -> "this@" + n.removePrefix("\$this\$")
            n == "this\$0" -> "this@outer"
            n.startsWith("\$dstr\$") -> "(" + n.removePrefix("\$dstr\$").split('$').joinToString(", ") + ")"
            n.startsWith("\$") && n.length > 1 && !n.startsWith("\$\$") -> n.substring(1) // captured variable
            else -> n
        }
    }

    fun visibleLocalsSafe(frame: com.sun.jdi.StackFrame): List<LocalVariable> = try {
        frame.visibleVariables()
    } catch (e: AbsentInformationException) { emptyList() }

    // ---- methods ---------------------------------------------------------------------------

    /** Methods a "step" should never stop in (bridges, default-arg trampolines, accessors). */
    fun isStepThroughMethod(method: Method): Boolean {
        val name = method.name()
        return method.isBridge || name.endsWith("\$default") || name.startsWith("access\$") ||
            method.declaringType().name().contains("\$\$Lambda") ||
            method.declaringType().name().contains("\$\$SpringCGLIB\$\$") ||
            method.declaringType().name().contains("\$\$EnhancerBySpringCGLIB\$\$")
    }

    /** True for a named `suspend fun` (compiled with a trailing Continuation parameter). */
    fun isSuspendFunction(method: Method): Boolean =
        method.argumentTypeNames().lastOrNull() == CONTINUATION_TYPE

    /** True for the state-machine body of a suspend lambda / continuation class. */
    fun isInvokeSuspend(method: Method): Boolean =
        method.name() == "invokeSuspend" && isSubclassOf(method.declaringType(), BASE_CONTINUATION_IMPL)

    fun isSubclassOf(type: ReferenceType, name: String): Boolean {
        var t: ClassType? = type as? ClassType
        while (t != null) {
            if (t.name() == name) return true
            t = t.superclass()
        }
        return false
    }

    /** Pretty, Kotlin-flavoured type name for display. */
    fun typeDisplayName(jvmName: String): String {
        val simple = jvmName.substringAfterLast('.')
        return when (jvmName) {
            "java.lang.String" -> "String"
            "java.lang.Integer", "int" -> "Int"
            "java.lang.Long", "long" -> "Long"
            "java.lang.Boolean", "boolean" -> "Boolean"
            "java.lang.Double", "double" -> "Double"
            "java.lang.Float", "float" -> "Float"
            "java.lang.Short", "short" -> "Short"
            "java.lang.Byte", "byte" -> "Byte"
            "java.lang.Character", "char" -> "Char"
            "java.lang.Object" -> "Any"
            "int[]" -> "IntArray"
            "long[]" -> "LongArray"
            "boolean[]" -> "BooleanArray"
            "double[]" -> "DoubleArray"
            "float[]" -> "FloatArray"
            "short[]" -> "ShortArray"
            "byte[]" -> "ByteArray"
            "char[]" -> "CharArray"
            else -> if (jvmName.endsWith("[]")) "Array<${typeDisplayName(jvmName.removeSuffix("[]"))}>" else simple
        }
    }
}
