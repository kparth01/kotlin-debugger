package com.example.demo.service

import com.example.demo.domain.Discount
import com.example.demo.domain.Order
import com.example.demo.domain.itemCount
import com.example.demo.domain.subtotal
import com.example.demo.support.timed
import org.springframework.stereotype.Service
import java.math.BigDecimal
import java.math.RoundingMode

@Service
class PricingService {
    fun discountFor(order: Order): Discount = when {
        order.itemCount >= BULK_THRESHOLD -> Discount.Percentage(10) // @bp:discount-bulk
        order.customerId.startsWith("vip-") -> Discount.Fixed(BigDecimal("5.00"))
        else -> Discount.None
    }

    fun price(order: Order): BigDecimal = timed("price") {
        val subtotal = order.subtotal() // @bp:price-subtotal
        val discount = discountFor(order)
        val total = when (discount) {
            is Discount.Percentage -> subtotal - subtotal * discount.percent.toBigDecimal() / HUNDRED
            is Discount.Fixed -> (subtotal - discount.amount).max(BigDecimal.ZERO)
            Discount.None -> subtotal
        }
        total.setScale(2, RoundingMode.HALF_UP) // @bp:price-total
    }

    companion object {
        const val BULK_THRESHOLD = 10
        private val HUNDRED = BigDecimal(100)
    }
}
