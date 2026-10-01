package dev.ktdebug.util

/**
 * Hit conditions as typed in VS Code's breakpoint editor:
 *   `5` or `== 5`  stop on the 5th hit only
 *   `> 5`, `>= 5`, `< 5`, `<= 5`
 *   `% 3`          stop on every 3rd hit
 */
object HitCondition {
    private val pattern = Regex("^\\s*(==|>=|<=|>|<|%)?\\s*(\\d+)\\s*$")

    fun isValid(expr: String) = pattern.matches(expr)

    fun matches(expr: String, hits: Int): Boolean {
        val m = pattern.matchEntire(expr) ?: return true
        val n = m.groupValues[2].toInt()
        return when (m.groupValues[1]) {
            "", "==" -> hits == n
            ">" -> hits > n
            ">=" -> hits >= n
            "<" -> hits < n
            "<=" -> hits <= n
            "%" -> n > 0 && hits % n == 0
            else -> true
        }
    }
}
