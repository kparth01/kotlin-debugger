package fixture

class InsufficientFunds(val needed: Int) : RuntimeException("need $needed more")

fun withdraw(balance: Int, amount: Int): Int {
    if (amount > balance) throw InsufficientFunds(amount - balance) // @bp:throw
    return balance - amount
}

fun exceptions() {
    try {
        withdraw(10, 50)
    } catch (e: InsufficientFunds) {
        println("caught ${e.needed}") // @bp:caught
    }
    withdraw(5, 100)
}
