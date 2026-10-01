package dev.ktdebug.eval

class EvalException(message: String) : Exception(message)

enum class T { IDENT, INT, LONG, DOUBLE, FLOAT, CHAR, STRING, OP, EOF }

/** For STRING tokens [parts] holds template pieces: String literal text or nested expression source. */
data class Token(val type: T, val text: String, val pos: Int, val parts: List<Any> = emptyList())

class Lexer(private val src: String) {
    private var i = 0

    fun tokens(): List<Token> {
        val out = mutableListOf<Token>()
        while (true) {
            skipWs()
            if (i >= src.length) { out += Token(T.EOF, "", i); return out }
            val c = src[i]
            val start = i
            out += when {
                c.isLetter() || c == '_' -> ident()
                c == '`' -> {
                    val end = src.indexOf('`', i + 1).takeIf { it > 0 } ?: throw EvalException("Unterminated backtick identifier")
                    Token(T.IDENT, src.substring(i + 1, end), start).also { i = end + 1 }
                }
                c == '$' && i + 1 < src.length && (src[i + 1].isLetter() || src[i + 1] == '_' || src[i + 1] == '$') -> ident()
                c.isDigit() || (c == '.' && i + 1 < src.length && src[i + 1].isDigit()) -> number()
                c == '"' -> string()
                c == '\'' -> char()
                else -> op()
            }
        }
    }

    private fun skipWs() { while (i < src.length && src[i].isWhitespace()) i++ }

    private fun ident(): Token {
        val start = i
        i++
        while (i < src.length && (src[i].isLetterOrDigit() || src[i] == '_' || src[i] == '$')) i++
        return Token(T.IDENT, src.substring(start, i), start)
    }

    private fun number(): Token {
        val start = i
        if (src.startsWith("0x", i) || src.startsWith("0X", i)) {
            i += 2
            while (i < src.length && (src[i].isLetterOrDigit() || src[i] == '_')) i++
            val raw = src.substring(start + 2, i).replace("_", "")
            return if (raw.endsWith("L")) Token(T.LONG, raw.dropLast(1).toLong(16).toString(), start)
            else Token(T.INT, raw.toLong(16).toString(), start)
        }
        var isFloat = false
        while (i < src.length && (src[i].isDigit() || src[i] == '_')) i++
        if (i < src.length && src[i] == '.' && i + 1 < src.length && src[i + 1].isDigit()) {
            isFloat = true; i++
            while (i < src.length && (src[i].isDigit() || src[i] == '_')) i++
        }
        if (i < src.length && (src[i] == 'e' || src[i] == 'E')) {
            isFloat = true; i++
            if (i < src.length && (src[i] == '+' || src[i] == '-')) i++
            while (i < src.length && src[i].isDigit()) i++
        }
        val text = src.substring(start, i).replace("_", "")
        if (i < src.length) when (src[i]) {
            'L' -> { i++; return Token(T.LONG, text, start) }
            'f', 'F' -> { i++; return Token(T.FLOAT, text, start) }
            'd', 'D' -> { i++; return Token(T.DOUBLE, text, start) }
        }
        return Token(if (isFloat) T.DOUBLE else T.INT, text, start)
    }

    private fun escape(): Char {
        val c = src[i++]
        return when (c) {
            'n' -> '\n'; 't' -> '\t'; 'r' -> '\r'; 'b' -> '\b'
            '0' -> '\u0000'
            'u' -> { val code = src.substring(i, i + 4).toInt(16); i += 4; code.toChar() }
            else -> c
        }
    }

    private fun char(): Token {
        val start = i
        i++
        val ch = if (src[i] == '\\') { i++; escape() } else src[i++]
        if (i >= src.length || src[i] != '\'') throw EvalException("Unterminated char literal")
        i++
        return Token(T.CHAR, ch.toString(), start)
    }

    private fun string(): Token {
        val start = i
        i++
        val parts = mutableListOf<Any>()
        val sb = StringBuilder()
        while (true) {
            if (i >= src.length) throw EvalException("Unterminated string literal")
            val c = src[i]
            when {
                c == '"' -> { i++; break }
                c == '\\' -> { i++; sb.append(escape()) }
                c == '$' && i + 1 < src.length && src[i + 1] == '{' -> {
                    if (sb.isNotEmpty()) { parts += sb.toString(); sb.clear() }
                    var depth = 1
                    val exprStart = i + 2
                    i += 2
                    while (i < src.length && depth > 0) {
                        if (src[i] == '{') depth++ else if (src[i] == '}') depth--
                        i++
                    }
                    parts += TemplateExpr(src.substring(exprStart, i - 1))
                }
                c == '$' && i + 1 < src.length && (src[i + 1].isLetter() || src[i + 1] == '_') -> {
                    if (sb.isNotEmpty()) { parts += sb.toString(); sb.clear() }
                    val s = ++i
                    while (i < src.length && (src[i].isLetterOrDigit() || src[i] == '_')) i++
                    parts += TemplateExpr(src.substring(s, i))
                }
                else -> { sb.append(c); i++ }
            }
        }
        if (sb.isNotEmpty() || parts.isEmpty()) parts += sb.toString()
        return Token(T.STRING, src.substring(start, i), start, parts)
    }

    private fun op(): Token {
        val start = i
        for (o in OPS) if (src.startsWith(o, i)) {
            // `!is` / `!in` are operators only when not followed by more identifier characters (`!isEmpty()`).
            if ((o == "!is" || o == "!in") && i + 3 < src.length && (src[i + 3].isLetterOrDigit() || src[i + 3] == '_')) continue
            i += o.length
            return Token(T.OP, o, start)
        }
        throw EvalException("Unexpected character '${src[i]}' at ${i + 1}")
    }

    companion object {
        private val OPS = listOf(
            "===", "!==", "!is", "!in", "?.", "?:", "!!", "==", "!=", "<=", ">=", "&&", "||", "::",
            "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", "[", "]", ".", ",", "=", "@", "?", "{", "}",
        )
    }
}

data class TemplateExpr(val source: String)
