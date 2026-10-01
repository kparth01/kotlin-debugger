package fixture

import fixture.util.retry

fun String.shout(times: Int): String {
    val base = uppercase() // @bp:extension
    return base + "!".repeat(times)
}

fun lambdas() {
    val prefix = "item"
    val transform: (Int) -> String = { n -> "$prefix-$n" }
    val labels = (1..3).map(transform)
    val sorted = labels.sortedWith(Comparator { a, b ->
        b.compareTo(a) // @bp:comparator
    })
    val runnable = object : Runnable {
        override fun run() {
            println("anon $prefix") // @bp:anonymous
        }
    }
    runnable.run()
    val result = retry(2) { attempt ->
        "attempt-$attempt-$prefix" // @bp:retry-lambda
    }
    println("shout=" + "hey".shout(2) + " $sorted $result")
}
