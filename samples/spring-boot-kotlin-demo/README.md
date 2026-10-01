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

## Run with a debug port

```bash
mvn -DskipTests package
java '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005' \
     -jar target/spring-boot-kotlin-demo.jar
```

Open this folder in VS Code, choose **Attach to Spring Boot demo (Kotlin)** (`.vscode/launch.json`)
and press F5. Then try:

```bash
curl -X POST localhost:8080/orders -H 'Content-Type: application/json' \
  -d '{"customerId":"vip-1","lines":[{"productId":"apple","quantity":12,"unitPrice":0.5}]}'
curl "localhost:8080/orders/quote?ids=apple,pear,melon"     # suspend endpoint
curl localhost:8080/orders/999                              # OrderNotFoundException -> 404
```

Good places for breakpoints:
- `OrderController.create`
- `OrderService.placeOrder`, which sits behind a CGLIB proxy
- the `timed { }` body in `PricingService.price`
- `Instrumentation.kt` inside the inline `timed`
- `CatalogClient.price` after `delay`
- `OrderService.findOrder`, with the *Caught Exceptions (application code)* exception filter enabled

To try virtual threads, add `--spring.threads.virtual.enabled=true`.
