package dev.ktdebug.eval

sealed class Expr {
    data class Literal(val value: Any?) : Expr()
    data class Template(val parts: List<Any>) : Expr()          // String | Expr
    data class Name(val name: String) : Expr()
    data class This(val label: String?) : Expr()
    data class Member(val target: Expr, val name: String, val safe: Boolean) : Expr()
    data class Call(val target: Expr?, val name: String, val args: List<Expr>, val safe: Boolean) : Expr()
    data class Index(val target: Expr, val index: Expr) : Expr()
    data class Unary(val op: String, val operand: Expr) : Expr()
    data class Binary(val op: String, val left: Expr, val right: Expr) : Expr()
    data class NotNull(val operand: Expr) : Expr()
    data class Is(val operand: Expr, val type: String, val negated: Boolean) : Expr()
    data class In(val operand: Expr, val container: Expr, val negated: Boolean) : Expr()
    data class As(val operand: Expr, val type: String, val safe: Boolean) : Expr()
    data class Assign(val target: Expr, val value: Expr) : Expr()
}

/** Recursive-descent parser for the supported Kotlin expression subset (Kotlin precedence). */
class Parser(source: String) {
    private val tokens = Lexer(source).tokens()
    private var p = 0

    companion object {
        fun parse(source: String): Expr = Parser(source).parseAll()
    }

    fun parseAll(): Expr {
        if (peek().type == T.EOF) throw EvalException("Empty expression")
        val e = assignment()
        if (peek().type != T.EOF) throw EvalException("Unexpected '${peek().text}' at ${peek().pos + 1}")
        return e
    }

    private fun peek(o: Int = 0) = tokens[minOf(p + o, tokens.size - 1)]
    private fun next() = tokens[p++]
    private fun isOp(s: String, o: Int = 0) = peek(o).type == T.OP && peek(o).text == s
    private fun isKw(s: String) = peek().type == T.IDENT && peek().text == s
    private fun accept(s: String): Boolean = if (isOp(s)) { p++; true } else false
    private fun expect(s: String) { if (!accept(s)) throw EvalException("Expected '$s' but found '${peek().text.ifEmpty { "end of expression" }}'") }

    private fun assignment(): Expr {
        val left = disjunction()
        if (isOp("=")) {
            next()
            if (left !is Expr.Name && left !is Expr.Member && left !is Expr.Index) throw EvalException("Invalid assignment target")
            return Expr.Assign(left, disjunction())
        }
        return left
    }

    private fun disjunction(): Expr {
        var e = conjunction()
        while (accept("||")) e = Expr.Binary("||", e, conjunction())
        return e
    }

    private fun conjunction(): Expr {
        var e = equality()
        while (accept("&&")) e = Expr.Binary("&&", e, equality())
        return e
    }

    private fun equality(): Expr {
        var e = comparison()
        while (true) {
            val op = listOf("===", "!==", "==", "!=").firstOrNull { isOp(it) } ?: return e
            next(); e = Expr.Binary(op, e, comparison())
        }
    }

    private fun comparison(): Expr {
        var e = namedCheck()
        while (true) {
            val op = listOf("<=", ">=", "<", ">").firstOrNull { isOp(it) } ?: return e
            next(); e = Expr.Binary(op, e, namedCheck())
        }
    }

    private fun namedCheck(): Expr {
        val e = elvis()
        return when {
            isKw("is") -> { next(); Expr.Is(e, type(), false) }
            isOp("!is") -> { next(); Expr.Is(e, type(), true) }
            isKw("in") -> { next(); Expr.In(e, elvis(), false) }
            isOp("!in") -> { next(); Expr.In(e, elvis(), true) }
            else -> e
        }
    }

    private fun elvis(): Expr {
        var e = additive()
        while (accept("?:")) e = Expr.Binary("?:", e, additive())
        return e
    }

    private fun additive(): Expr {
        var e = multiplicative()
        while (true) {
            val op = listOf("+", "-").firstOrNull { isOp(it) } ?: return e
            next(); e = Expr.Binary(op, e, multiplicative())
        }
    }

    private fun multiplicative(): Expr {
        var e = asExpr()
        while (true) {
            val op = listOf("*", "/", "%").firstOrNull { isOp(it) } ?: return e
            next(); e = Expr.Binary(op, e, asExpr())
        }
    }

    private fun asExpr(): Expr {
        var e = prefix()
        while (isKw("as")) {
            next()
            val safe = accept("?")
            e = Expr.As(e, type(), safe)
        }
        return e
    }

    private fun prefix(): Expr = when {
        isOp("-") -> { next(); Expr.Unary("-", prefix()) }
        isOp("+") -> { next(); prefix() }
        isOp("!") -> { next(); Expr.Unary("!", prefix()) }
        else -> postfix()
    }

    private fun postfix(): Expr {
        var e = primary()
        while (true) {
            e = when {
                isOp(".") || isOp("?.") -> {
                    val safe = next().text == "?."
                    val name = ident()
                    if (isOp("(")) Expr.Call(e, name, args(), safe) else Expr.Member(e, name, safe)
                }
                isOp("[") -> { next(); val idx = disjunction(); expect("]"); Expr.Index(e, idx) }
                isOp("!!") -> { next(); Expr.NotNull(e) }
                isOp("(") && e is Expr.Name -> Expr.Call(null, e.name, args(), false)
                else -> return e
            }
        }
    }

    private fun args(): List<Expr> {
        expect("(")
        val list = mutableListOf<Expr>()
        if (accept(")")) return list
        do {
            // named arguments (`name = value`) are accepted but matched positionally
            if (peek().type == T.IDENT && isOp("=", 1) && !isOp("==", 1)) { next(); next() }
            list += disjunction()
        } while (accept(","))
        expect(")")
        if (isOp("{")) throw EvalException("Lambda arguments are not supported in debugger expressions")
        return list
    }

    private fun ident(): String {
        val t = next()
        if (t.type != T.IDENT) throw EvalException("Expected a name but found '${t.text}'")
        return t.text
    }

    private fun type(): String {
        val sb = StringBuilder(ident())
        while (isOp(".") && peek(1).type == T.IDENT) { next(); sb.append('.').append(ident()) }
        if (isOp("<")) { // skip generic arguments
            var depth = 0
            do {
                if (isOp("<")) depth++ else if (isOp(">")) depth--
                next()
            } while (depth > 0 && peek().type != T.EOF)
        }
        accept("?")
        return sb.toString()
    }

    private fun primary(): Expr {
        val t = next()
        return when (t.type) {
            T.INT -> {
                val v = t.text.toLong()
                Expr.Literal(if (v in Int.MIN_VALUE..Int.MAX_VALUE) v.toInt() else v)
            }
            T.LONG -> Expr.Literal(t.text.toLong())
            T.DOUBLE -> Expr.Literal(t.text.toDouble())
            T.FLOAT -> Expr.Literal(t.text.toFloat())
            T.CHAR -> Expr.Literal(t.text[0])
            T.STRING -> {
                val parts = t.parts.map { if (it is TemplateExpr) Parser(it.source).parseAll() else it }
                if (parts.all { it is String }) Expr.Literal(parts.joinToString("")) else Expr.Template(parts)
            }
            T.IDENT -> when (t.text) {
                "true" -> Expr.Literal(true)
                "false" -> Expr.Literal(false)
                "null" -> Expr.Literal(null)
                "this" -> if (isOp("@")) { next(); Expr.This(ident()) } else Expr.This(null)
                else -> Expr.Name(t.text)
            }
            T.OP -> when (t.text) {
                "(" -> { val e = assignment(); expect(")"); e }
                else -> throw EvalException("Unexpected '${t.text}' at ${t.pos + 1}")
            }
            T.EOF -> throw EvalException("Unexpected end of expression")
        }
    }
}
