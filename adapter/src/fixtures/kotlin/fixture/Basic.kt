package fixture

data class Customer(val id: Long, val name: String, val tags: List<String>)

class OrderService(private val taxRate: Double) {
    private val orders = mutableMapOf<Long, Order>()

    fun place(customer: Customer, amounts: List<Int>): Order {
        val subtotal = amounts.sum() // @bp:place-subtotal
        val total = applyTax(subtotal) // @bp:place-total
        val order = Order(nextId(), customer, total)
        orders[order.id] = order
        return order // @bp:place-return
    }

    private fun applyTax(amount: Int): Double {
        val tax = amount * taxRate // @bp:apply-tax
        return amount + tax
    }

    companion object {
        private var counter = 100L
        fun nextId(): Long = ++counter // @bp:companion
    }
}

data class Order(val id: Long, val customer: Customer, val total: Double)

fun basic() {
    val service = OrderService(0.25)
    val customer = Customer(7, "Ada", listOf("vip", "beta"))
    val order = service.place(customer, listOf(10, 20, 30)) // @bp:basic-call
    println("order=$order") // @bp:basic-after
}
