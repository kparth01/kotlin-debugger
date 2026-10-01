package fixture

interface Repository<T, ID> {
    fun save(entity: T): T
    fun findById(id: ID): T?
}

class InMemoryRepository<T : Any, ID>(private val idOf: (T) -> ID) : Repository<T, ID> {
    private val store = linkedMapOf<ID, T>()

    override fun save(entity: T): T {
        store[idOf(entity)] = entity // @bp:generic-save
        return entity
    }

    override fun findById(id: ID): T? = store[id]
}

sealed interface Outcome<out T> {
    data class Ok<T>(val value: T) : Outcome<T>
    data class Err(val reason: String) : Outcome<Nothing>
}

fun generics() {
    val repo = InMemoryRepository<Customer, Long> { it.id }
    repo.save(Customer(1, "Grace", emptyList()))
    val found = repo.findById(1)
    val outcome: Outcome<Customer> = if (found != null) Outcome.Ok(found) else Outcome.Err("missing")
    println("outcome=$outcome") // @bp:generic-result
}
