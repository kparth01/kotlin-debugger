package fixture

import fixture.util.measured

fun inlineScenario() {
    val numbers = listOf(1, 2, 3, 4)
    val total = measured("sum") { // @bp:inline-call
        val doubled = numbers.map { it * 2 } // @bp:inline-lambda
        doubled.sum()
    }
    println("total=$total") // @bp:inline-after
}
