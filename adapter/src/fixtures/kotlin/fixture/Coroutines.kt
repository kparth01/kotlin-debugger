package fixture

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

suspend fun fetchPrice(item: String): Int {
    delay(20)
    val price = item.length * 10 // @bp:after-delay
    return price
}

suspend fun loadCart(items: List<String>): Int {
    var sum = 0
    for (item in items) {
        val p = fetchPrice(item) // @bp:suspend-call
        sum += p // @bp:after-suspend
    }
    return sum
}

fun coroutines() = runBlocking {
    val total = withContext(Dispatchers.Default) { loadCart(listOf("apple", "kiwi")) }
    val deferred = async(Dispatchers.Default) { fetchPrice("banana") }
    println("cart=$total banana=${deferred.await()}")
}
