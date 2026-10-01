package dev.ktdebug

import dev.ktdebug.eval.EvalException
import dev.ktdebug.eval.Expr
import dev.ktdebug.eval.Parser
import dev.ktdebug.jdi.Kotlin
import dev.ktdebug.session.SessionConfig
import dev.ktdebug.session.SourceIndex
import dev.ktdebug.util.HitCondition
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class ParserTest {
    @Test
    fun `member chains, calls, index and safe calls`() {
        val e = Parser.parse("order?.customer!!.tags[0].uppercase()")
        assertTrue(e is Expr.Call && e.name == "uppercase")
        val idx = (e as Expr.Call).target as Expr.Index
        assertTrue(idx.target is Expr.Member)
    }

    @Test
    fun `kotlin precedence`() {
        val e = Parser.parse("a + b * c == d && !e || f ?: g")
        assertTrue(e is Expr.Binary && e.op == "||")
        val and = (e as Expr.Binary).left as Expr.Binary
        assertEquals("&&", and.op)
        assertEquals("==", (and.left as Expr.Binary).op)
    }

    @Test
    fun `is, in, as and this labels`() {
        assertTrue(Parser.parse("x is com.example.Order") is Expr.Is)
        assertTrue(Parser.parse("x !is Order").let { it is Expr.Is && it.negated })
        assertTrue(Parser.parse("\"a\" in tags") is Expr.In)
        assertTrue(Parser.parse("x as? List<String>").let { it is Expr.As && it.safe })
        assertEquals(Expr.This("apply"), Parser.parse("this@apply"))
        // !isEmpty() must not be lexed as `!is Empty`
        assertTrue(Parser.parse("!isEmpty()") is Expr.Unary)
    }

    @Test
    fun `literals and templates`() {
        assertEquals(Expr.Literal(42), Parser.parse("42"))
        assertEquals(Expr.Literal(42L), Parser.parse("42L"))
        assertEquals(Expr.Literal(1_000_000), Parser.parse("1_000_000"))
        assertEquals(Expr.Literal(0.5), Parser.parse("0.5"))
        assertEquals(Expr.Literal(1.5f), Parser.parse("1.5f"))
        assertEquals(Expr.Literal('x'), Parser.parse("'x'"))
        assertEquals(Expr.Literal("a\nb"), Parser.parse("\"a\\nb\""))
        val t = Parser.parse("\"id=\$id total=\${order.total}\"") as Expr.Template
        assertEquals(4, t.parts.size)
        assertEquals(Expr.Name("id"), t.parts[1])
    }

    @Test
    fun `assignment and errors`() {
        assertTrue(Parser.parse("count = count + 1") is Expr.Assign)
        assertThrows<EvalException> { Parser.parse("a +") }
        assertThrows<EvalException> { Parser.parse("list.map { it }") }
        assertThrows<EvalException> { Parser.parse("") }
    }
}

class HitConditionTest {
    @Test
    fun conditions() {
        assertTrue(HitCondition.matches("3", 3)); assertFalse(HitCondition.matches("3", 4))
        assertTrue(HitCondition.matches(">= 2", 2)); assertFalse(HitCondition.matches("> 2", 2))
        assertTrue(HitCondition.matches("%3", 6)); assertFalse(HitCondition.matches("%3", 7))
        assertTrue(HitCondition.matches("< 5", 4))
        assertFalse(HitCondition.isValid("abc"))
    }
}

class KotlinNamesTest {
    @Test
    fun `compiler generated names`() {
        assertTrue(Kotlin.isHiddenLocal("\$i\$f\$measured"))
        assertTrue(Kotlin.isHiddenLocal("\$i\$a\$-map-Greeter\$greet\$1"))
        assertTrue(Kotlin.isHiddenLocal("\$completion"))
        assertFalse(Kotlin.isHiddenLocal("label\$iv"))
        assertEquals(2, Kotlin.inlineDepth("item\$iv\$iv"))
        assertEquals("item", Kotlin.displayName("item\$iv\$iv"))
        assertEquals("this@apply", Kotlin.displayName("\$this\$apply"))
        assertEquals("this@map", Kotlin.displayName("\$this\$map\$iv"))
        assertEquals("prefix", Kotlin.displayName("\$prefix"))
        assertEquals("this@outer", Kotlin.displayName("this\$0"))
        assertEquals("com/example", Kotlin.packageDirOf("com/example/util/../TimingKt".replace("/util/..", "")))
        assertEquals("", Kotlin.packageDirOf("MainKt"))
    }

    @Test
    fun `type display names`() {
        assertEquals("String", Kotlin.typeDisplayName("java.lang.String"))
        assertEquals("IntArray", Kotlin.typeDisplayName("int[]"))
        assertEquals("Array<String>", Kotlin.typeDisplayName("java.lang.String[]"))
        assertEquals("Order", Kotlin.typeDisplayName("com.example.Order"))
    }
}

class SourceIndexTest {
    @Test
    fun `package parsing ignores comments and annotations`() {
        assertEquals("com.example.orders", SourceIndex.parsePackage("""
            /* license
               package not.this */
            // package nor.this
            @file:JvmName("Orders")
            package com.example.orders

            class X
        """.trimIndent()))
        assertEquals("a.b", SourceIndex.parsePackage("package a.b;\nclass J {}"))
        assertEquals("", SourceIndex.parsePackage("fun main() {}"))
        assertEquals("my.`fun`.pkg".replace("`", ""), SourceIndex.parsePackage("package my.`fun`.pkg"))
    }

    @Test
    fun `resolves by package not directory and skips build dirs`(@TempDir dir: Path) {
        val a = dir.resolve("svc-a/src/main/kotlin/whatever/Utils.kt")
        val b = dir.resolve("svc-b/src/main/kotlin/Utils.kt")
        val generated = dir.resolve("svc-a/build/generated/Utils.kt")
        for ((p, pkg) in listOf(a to "com.a", b to "com.b", generated to "com.gen")) {
            Files.createDirectories(p.parent)
            Files.writeString(p, "package $pkg\n\nfun x() = 1\n")
        }
        val index = SourceIndex(listOf(dir)).build()
        assertEquals(a, index.resolve("com/a", "Utils.kt"))
        assertEquals(b, index.resolve("com/b", "Utils.kt"))
        assertNull(index.resolve("com/gen", "Utils.kt"))
        assertNull(index.resolve("com/c", "Utils.kt")) // ambiguous by name alone
        assertTrue("com.a" in index.projectPackages)
    }
}

class SessionConfigTest {
    @Test
    fun `attach defaults and aliases`() {
        val c = SessionConfig.from("attach", mapOf("host" to "10.0.0.5", "port" to 5006.0, "projectRoot" to "/tmp/x"))
        assertEquals("10.0.0.5", c.hostName)
        assertEquals(5006, c.port)
        assertEquals(30_000, c.timeoutMs)
        assertTrue(c.isAttach)
        assertTrue("kotlin.*" in c.stepFilters)
    }

    @Test
    fun `argument splitting`() {
        assertEquals(listOf("-Xmx1g", "-Dname=a b", "--x"), SessionConfig.splitArgs("-Xmx1g \"-Dname=a b\" --x"))
    }
}

class FrameNameTest {
    private fun n(c: String, m: String) = dev.ktdebug.jdi.StackBuilder.prettyName(c, m)

    @Test
    fun names() {
        assertEquals("OrderService.placeOrder", n("com.x.OrderService", "placeOrder"))
        assertEquals("OrderService.Companion.nextId", n("com.x.OrderService\$Companion", "nextId"))
        assertEquals("LambdasKt.lambdas { lambda }", n("com.x.LambdasKt", "lambdas\$lambda\$3"))
        assertEquals("OrderService.quote.prices { suspend }", n("com.x.OrderService\$quote\$2\$prices\$1\$1", "invokeSuspend"))
        assertEquals("OrderService.placeOrder (Spring proxy)", n("com.x.OrderService\$\$SpringCGLIB\$\$0", "placeOrder"))
        assertEquals("Account.transfer", n("com.x.Account", "transfer-Gt7mH5k"))
        assertEquals("Repo.save", n("com.x.Repo", "save\$suspendImpl"))
    }
}
