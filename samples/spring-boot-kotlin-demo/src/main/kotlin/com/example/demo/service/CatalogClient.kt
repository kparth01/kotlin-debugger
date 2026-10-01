package com.example.demo.service

import kotlinx.coroutines.delay
import org.springframework.stereotype.Component
import java.math.BigDecimal

/** Pretends to be a remote catalog service: every lookup suspends. */
@Component
class CatalogClient {
    private val prices = mapOf("apple" to "0.50", "pear" to "0.75", "melon" to "3.20")

    suspend fun price(productId: String): BigDecimal {
        delay(15)
        val raw = prices[productId] ?: "9.99" // @bp:catalog-price
        return BigDecimal(raw)
    }
}
