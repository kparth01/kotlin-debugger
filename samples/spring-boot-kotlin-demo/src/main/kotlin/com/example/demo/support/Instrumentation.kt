package com.example.demo.support

import org.aspectj.lang.ProceedingJoinPoint
import org.aspectj.lang.annotation.Around
import org.aspectj.lang.annotation.Aspect
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** Inline helper in another package: its body is copied into every caller. */
inline fun <T> timed(name: String, block: () -> T): T {
    val started = System.nanoTime()
    val result = block() // @bp:timed-body
    LoggerFactory.getLogger("timing").debug("{} took {} us", name, (System.nanoTime() - started) / 1000)
    return result
}

@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
annotation class Audited

/** Makes Spring wrap @Audited beans in CGLIB proxies (like @Transactional would). */
@Aspect
@Component
class AuditAspect {
    private val log = LoggerFactory.getLogger(javaClass)

    @Around("@within(com.example.demo.support.Audited)")
    fun audit(pjp: ProceedingJoinPoint): Any? {
        log.debug("-> {}", pjp.signature.toShortString())
        return pjp.proceed()
    }
}
