package com.example.demo.service

import com.example.demo.domain.Order
import com.example.demo.domain.OrderNotFoundException
import com.example.demo.domain.OrderRequest
import com.example.demo.domain.OrderStatus
import com.example.demo.repo.OrderRepository
import com.example.demo.support.Audited
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import org.springframework.stereotype.Service
import java.math.BigDecimal

@Service
@Audited
class OrderService(
    private val repository: OrderRepository,
    private val pricing: PricingService,
    private val catalog: CatalogClient,
) {
    fun placeOrder(request: OrderRequest): Order {
        require(request.lines.isNotEmpty()) { "an order needs at least one line" }
        val draft = Order(id = repository.nextId(), customerId = request.customerId, lines = request.lines) // @bp:place-draft
        val total = pricing.price(draft)
        val priced = draft.copy(status = OrderStatus.PRICED, total = total) // @bp:place-priced
        return repository.save(priced)
    }

    fun findOrder(id: Long): Order =
        repository.findById(id) ?: throw OrderNotFoundException(id) // @bp:find-throw

    suspend fun quote(productIds: List<String>): Map<String, BigDecimal> = coroutineScope {
        val prices = productIds.map { id -> async { id to catalog.price(id) } }.awaitAll() // @bp:quote-async
        val quote = prices.toMap()
        quote // @bp:quote-result
    }

    fun totalRevenue(): BigDecimal = repository.findAll().fold(BigDecimal.ZERO) { acc, o -> acc + o.total }
}
