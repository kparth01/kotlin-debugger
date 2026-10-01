package com.example.demo.web

import com.example.demo.domain.Order
import com.example.demo.domain.OrderNotFoundException
import com.example.demo.domain.OrderRequest
import com.example.demo.service.OrderService
import org.springframework.http.HttpStatus
import org.springframework.http.ProblemDetail
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RestControllerAdvice
import java.math.BigDecimal

@RestController
@RequestMapping("/orders")
class OrderController(private val orders: OrderService) {

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(@RequestBody request: OrderRequest): Order {
        val order = orders.placeOrder(request) // @bp:controller-create
        return order
    }

    @GetMapping("/{id}")
    fun get(@PathVariable id: Long): Order = orders.findOrder(id) // @bp:controller-get

    @GetMapping("/quote")
    suspend fun quote(@RequestParam ids: List<String>): Map<String, BigDecimal> {
        val quote = orders.quote(ids) // @bp:controller-quote
        return quote
    }

    @GetMapping("/revenue")
    fun revenue(): BigDecimal = orders.totalRevenue()
}

@RestControllerAdvice
class ApiErrors {
    @ExceptionHandler(OrderNotFoundException::class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    fun notFound(e: OrderNotFoundException): ProblemDetail =
        ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.message ?: "not found").apply { setProperty("orderId", e.orderId) }
}
