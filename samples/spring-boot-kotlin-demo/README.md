# Spring Boot + Kotlin debugging demo

A small but realistic Spring Boot 3.5 / Kotlin 2 / coroutines service, used to validate the
debugger. It covers:

- REST controllers.
- An `@Aspect`, which makes Spring create CGLIB proxies the way `@Transactional` does.
- A generic repository, data and sealed classes, extension functions, and companion constants.
- An inline helper in another package (`support/timed`).
- Suspend endpoints with `async` and `delay`.
- Exceptions mapped by `@RestControllerAdvice`.

Lines tagged `// @bp:<name>` are used by the automated tests.

## Debug in VS Code

Open this folder in VS Code, build it once (`mvn -DskipTests package`, or **compile** in the Maven view), and press
F5: **Launch Spring Boot demo (Kotlin)** (`.vscode/launch.json`) starts the app under the debugger on port 8080.
**Debug** above `fun main` in `DemoApplication.kt` and **Debug** on `spring-boot:run` in the Maven view do the same.
Then try:

```bash
curl -X POST localhost:8080/orders -H 'Content-Type: application/json' \
  -d '{"customerId":"vip-1","lines":[{"productId":"apple","quantity":12,"unitPrice":0.5}]}'
curl "localhost:8080/orders/quote?ids=apple,pear,melon"     # suspend endpoint
curl localhost:8080/orders/999                              # OrderNotFoundException -> 404
```

### Attach to an app that is already running

Start it with a debug port, then add an attach configuration (**Run › Add Configuration… › Kotlin: Attach to JVM /
Spring Boot (JDWP)**, port 5005) and start that:

```bash
java '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005' \
     -jar target/spring-boot-kotlin-demo.jar
```

Good places for breakpoints:
- `OrderController.create`
- `OrderService.placeOrder`, which sits behind a CGLIB proxy
- the `timed { }` body in `PricingService.price`
- `Instrumentation.kt` inside the inline `timed`
- `CatalogClient.price` after `delay`
- `OrderService.findOrder`, with the *Caught Exceptions (application code)* exception filter enabled

To try virtual threads, add `--spring.threads.virtual.enabled=true`.
