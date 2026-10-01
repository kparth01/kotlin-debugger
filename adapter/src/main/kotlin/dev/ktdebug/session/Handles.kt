package dev.ktdebug.session

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Integer handles for DAP frame ids and variable references. Every handle is owned by a thread
 * and dropped when that thread resumes (JDI frames/values are only meaningful while suspended).
 */
class Handles<T : Any> {
    private val next = AtomicInteger(1)
    private val values = ConcurrentHashMap<Int, Pair<Long, T>>()

    fun create(owner: Long, value: T): Int {
        val id = next.getAndIncrement()
        values[id] = owner to value
        return id
    }

    operator fun get(id: Int): T? = values[id]?.second

    fun clearOwner(owner: Long) {
        values.entries.removeIf { it.value.first == owner }
    }

    fun clear() = values.clear()
}

/** Stable small integer ids for JDI threads (DAP thread ids are 32-bit). */
class ThreadIds {
    private val next = AtomicInteger(1)
    private val byUnique = ConcurrentHashMap<Long, Int>()
    private val threads = ConcurrentHashMap<Int, com.sun.jdi.ThreadReference>()

    fun idOf(t: com.sun.jdi.ThreadReference): Int {
        val unique = t.uniqueID()
        return byUnique.computeIfAbsent(unique) { next.getAndIncrement().also { id -> threads[id] = t } }
    }

    fun thread(id: Int): com.sun.jdi.ThreadReference? = threads[id]

    fun remove(t: com.sun.jdi.ThreadReference) {
        byUnique.remove(t.uniqueID())?.let { threads.remove(it) }
    }
}
