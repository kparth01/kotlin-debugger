package com.example.demo.repo

import com.example.demo.domain.Order
import org.springframework.stereotype.Repository
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

interface CrudStore<T : Any, ID : Any> {
    fun save(entity: T): T
    fun findById(id: ID): T?
    fun findAll(): List<T>
}

abstract class InMemoryStore<T : Any, ID : Any>(private val idOf: (T) -> ID) : CrudStore<T, ID> {
    protected val items = ConcurrentHashMap<ID, T>()

    override fun save(entity: T): T {
        val id = idOf(entity)
        items[id] = entity // @bp:store-save
        return entity
    }

    override fun findById(id: ID): T? = items[id]

    override fun findAll(): List<T> = items.values.toList()
}

@Repository
class OrderRepository : InMemoryStore<Order, Long>({ it.id }) {
    private val sequence = AtomicLong(1000)

    fun nextId(): Long = sequence.incrementAndGet()
}
