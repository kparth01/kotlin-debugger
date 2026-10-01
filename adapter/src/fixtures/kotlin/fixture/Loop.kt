package fixture

fun loop() {
    var acc = 0
    for (i in 1..10) {
        acc += i // @bp:loop-body
    }
    println("acc=$acc")
}

object Ticker {
    var ticks = 0

    fun tick(i: Int): Int {
        ticks += i // @bp:tick
        return ticks
    }
}

/** Long-running: lets tests attach to an already-running JVM (suspend=n) and pause it. */
fun spin() {
    val deadline = System.currentTimeMillis() + 60_000
    var i = 0
    while (System.currentTimeMillis() < deadline) {
        Ticker.tick(i++)
        Thread.sleep(50)
    }
}
