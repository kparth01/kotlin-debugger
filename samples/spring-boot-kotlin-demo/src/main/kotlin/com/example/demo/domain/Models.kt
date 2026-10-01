package com.example.demo.domain

import java.math.BigDecimal

enum class OrderStatus { NEW, PRICED, REJECTED }

data class OrderLine(val productId: String, val quantity: Int, val unitPrice: BigDecimal)

data class Order(
    val id: Long,
    val customerId: String,
    val lines: List<OrderLine>,
    val status: OrderStatus = OrderStatus.NEW,
    val total: BigDecimal = BigDecimal.ZERO,
)

data class OrderRequest(val customerId: String, val lines: List<OrderLine>)

sealed interface Discount {
    data object None : Discount
    data class Percentage(val percent: Int) : Discount
    data class Fixed(val amount: BigDecimal) : Discount
}

class OrderNotFoundException(val orderId: Long) : RuntimeException("Order $orderId not found")

/** Extension property/function used by the services (compiled as static methods in ModelsKt). */
val Order.itemCount: Int get() = lines.sumOf { it.quantity }

fun Order.subtotal(): BigDecimal =
    lines.fold(BigDecimal.ZERO) { acc, line -> acc + line.unitPrice * line.quantity.toBigDecimal() }
