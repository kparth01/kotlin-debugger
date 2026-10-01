package fixture

/** Debuggee used by the adapter's integration tests. One scenario per JVM run. */
fun main(args: Array<String>) {
    when (args.firstOrNull() ?: "basic") {
        "basic" -> basic()
        "inline" -> inlineScenario()
        "lambdas" -> lambdas()
        "exceptions" -> exceptions()
        "coroutines" -> coroutines()
        "generics" -> generics()
        "loop" -> loop()
        "spin" -> spin()
        else -> error("unknown scenario")
    }
    println("done")
}
