package fixture.util

inline fun <T> measured(label: String, block: () -> T): T {
    val start = System.nanoTime()
    val result = block() // @bp:inline-body
    println("$label took ${(System.nanoTime() - start) / 1000} us")
    return result
}

fun <T> retry(times: Int, action: (Int) -> T): T {
    var last: Throwable? = null
    for (attempt in 1..times) {
        try {
            return action(attempt)
        } catch (t: Throwable) {
            last = t
        }
    }
    throw IllegalStateException("gave up", last)
}
