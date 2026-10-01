package dev.ktdebug.session

import com.sun.jdi.Bootstrap
import com.sun.jdi.VirtualMachine
import com.sun.jdi.connect.AttachingConnector
import com.sun.jdi.connect.Connector
import dev.ktdebug.util.Log
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class ConnectException2(message: String) : Exception(message)

/** Connects JDI to a JVM: attach to `-agentlib:jdwp` sockets, or launch a JVM and attach to it. */
object VmConnector {

    fun attach(host: String, port: Int, timeoutMs: Int, onRetry: (String) -> Unit = {}): VirtualMachine {
        val connector = Bootstrap.virtualMachineManager().attachingConnectors()
            .firstOrNull { it.name() == "com.sun.jdi.SocketAttach" }
            ?: throw ConnectException2("This JDK has no socket attaching connector (com.sun.jdi.SocketAttach)")
        val deadline = System.currentTimeMillis() + timeoutMs.coerceAtLeast(1000)
        var lastError: Exception? = null
        var announced = false
        while (System.currentTimeMillis() < deadline) {
            try {
                return attachOnce(connector, host, port, (deadline - System.currentTimeMillis()).coerceIn(1000, 10_000))
            } catch (e: IOException) {
                lastError = e
                val handshake = e.message?.contains("handshake", ignoreCase = true) == true
                if (handshake) {
                    throw ConnectException2(
                        "Connected to $host:$port but the JDWP handshake failed. Either the port is not a JDWP " +
                            "debug port, or another debugger is already attached (JDWP allows one debugger at a time)."
                    )
                }
                if (!announced) {
                    onRetry("Waiting for JVM debug port $host:$port (${e.message ?: e.javaClass.simpleName}) …\n")
                    announced = true
                }
                Thread.sleep(500)
            }
        }
        val reason = when (lastError) {
            is ConnectException -> "connection refused"
            null -> "timed out"
            else -> lastError.message ?: lastError.javaClass.simpleName
        }
        throw ConnectException2(
            "Could not attach to JVM at $host:$port within ${timeoutMs / 1000}s ($reason). Start the JVM with\n" +
                "  -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:$port\n" +
                "and make sure the port is reachable (container port mapping / SSH tunnel / firewall)."
        )
    }

    private fun attachOnce(connector: AttachingConnector, host: String, port: Int, timeoutMs: Long): VirtualMachine {
        val args: Map<String, Connector.Argument> = connector.defaultArguments()
        args["hostname"]!!.setValue(host)
        args["port"]!!.setValue(port.toString())
        args["timeout"]?.setValue(timeoutMs.toString())
        val vm = connector.attach(args)
        Log.info("Attached to ${vm.name()} ${vm.version()} at $host:$port")
        return vm
    }

    data class Launched(val vm: VirtualMachine, val process: Process)

    /**
     * Launches the debuggee with JDWP listening on an ephemeral port (`address=127.0.0.1:0`); the
     * JVM prints the chosen port, which we parse from stdout before attaching.
     */
    fun launch(config: SessionConfig, output: (String, String) -> Unit): Launched {
        val mainClass = config.mainClass ?: throw ConnectException2("'mainClass' is required for launch")
        val java = config.javaExec ?: File(System.getProperty("java.home"), "bin/java").path
        val classpath = config.classPaths?.takeIf { it.isNotEmpty() }
            ?: ClasspathResolver.resolve(config.projectRoot ?: throw ConnectException2("'projectRoot' is required to compute a classpath"), output)
        if (classpath.isEmpty()) throw ConnectException2("Empty classpath. Build the project first or set 'classPaths'.")

        val argFile = Files.createTempFile("kda-classpath", ".args").toFile().apply { deleteOnExit() }
        argFile.writeText("-cp \"" + classpath.joinToString(File.pathSeparator).replace("\\", "\\\\") + "\"\n")
        val cmd = mutableListOf(java)
        cmd += config.vmArgs
        cmd += "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0"
        config.modulePaths?.takeIf { it.isNotEmpty() }?.let { cmd += listOf("--module-path", it.joinToString(File.pathSeparator)) }
        cmd += "@${argFile.absolutePath}"
        cmd += mainClass
        cmd += config.args
        Log.info("Launching: ${cmd.joinToString(" ")} (classpath: ${classpath.size} entries)")

        val pb = ProcessBuilder(cmd)
        (config.cwd ?: config.projectRoot)?.let { pb.directory(it.toFile()) }
        pb.environment().putAll(config.env)
        val process = pb.start()

        val port = CompletableFuture<Int>()
        val listening = Regex("Listening for transport dt_socket at address: (?:[^:]*:)?(\\d+)")
        Thread({
            process.inputStream.bufferedReader().useLines { lines ->
                for (line in lines) {
                    val m = listening.find(line)
                    if (m != null && !port.isDone) port.complete(m.groupValues[1].toInt())
                    else output(line + "\n", "stdout")
                }
            }
        }, "kda-stdout").apply { isDaemon = true }.start()
        Thread({
            process.errorStream.bufferedReader().useLines { lines -> lines.forEach { output(it + "\n", "stderr") } }
        }, "kda-stderr").apply { isDaemon = true }.start()
        process.onExit().thenRun { if (!port.isDone) port.completeExceptionally(ConnectException2("Debuggee exited with code ${process.exitValue()} before the debugger could attach")) }

        val p = try {
            port.get(60, TimeUnit.SECONDS)
        } catch (e: TimeoutException) {
            process.destroy(); throw ConnectException2("Debuggee did not open a JDWP port within 60s")
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        }
        return Launched(attach("127.0.0.1", p, 10_000), process)
    }
}

/** Best-effort runtime classpath discovery for `launch` (Maven, Gradle, or plain output dirs). */
object ClasspathResolver {
    fun resolve(root: Path, output: (String, String) -> Unit): List<String> {
        val dir = root.toFile()
        val result = LinkedHashSet<String>()
        val outputs = listOf(
            "target/classes", "build/classes/kotlin/main", "build/classes/java/main", "build/resources/main",
            "out/production/classes", "out/production/resources",
        ).map { File(dir, it) }.filter { it.isDirectory }.map { it.absolutePath }
        result += outputs
        try {
            when {
                File(dir, "pom.xml").isFile -> result += maven(dir, output)
                File(dir, "build.gradle.kts").isFile || File(dir, "build.gradle").isFile -> result += gradle(dir, output)
            }
        } catch (e: Exception) {
            output("[kotlin-debug] Classpath resolution failed: ${e.message}. Set 'classPaths' in launch.json.\n", "console")
        }
        return result.filter { File(it).exists() }
    }

    private fun maven(dir: File, output: (String, String) -> Unit): List<String> {
        val out = Files.createTempFile("kda-mvn-cp", ".txt").toFile().apply { deleteOnExit() }
        val wrapper = File(dir, if (isWindows()) "mvnw.cmd" else "mvnw")
        val mvn = if (wrapper.isFile) wrapper.absolutePath else if (isWindows()) "mvn.cmd" else "mvn"
        output("[kotlin-debug] Resolving classpath with Maven …\n", "console")
        run(dir, listOf(mvn, "-q", "-DincludeScope=runtime", "-Dmdep.outputFile=${out.absolutePath}", "dependency:build-classpath"))
        return out.readText().trim().split(File.pathSeparator).filter { it.isNotBlank() }
    }

    private fun gradle(dir: File, output: (String, String) -> Unit): List<String> {
        val init = Files.createTempFile("kda-init", ".gradle").toFile().apply { deleteOnExit() }
        init.writeText(
            """
            allprojects {
                tasks.register("kdaPrintClasspath") {
                    doLast {
                        def ss = project.extensions.findByName("sourceSets")
                        if (ss != null && ss.findByName("main") != null) {
                            println("KDA_CP=" + ss.main.runtimeClasspath.asPath)
                        }
                    }
                }
            }
            """.trimIndent()
        )
        val wrapper = File(dir, if (isWindows()) "gradlew.bat" else "gradlew")
        val gradle = if (wrapper.isFile) wrapper.absolutePath else "gradle"
        output("[kotlin-debug] Resolving classpath with Gradle …\n", "console")
        val text = run(dir, listOf(gradle, "-q", "--init-script", init.absolutePath, "kdaPrintClasspath"))
        return text.lines().filter { it.startsWith("KDA_CP=") }
            .flatMap { it.removePrefix("KDA_CP=").split(File.pathSeparator) }.filter { it.isNotBlank() }
    }

    private fun run(dir: File, cmd: List<String>): String {
        val p = ProcessBuilder(cmd).directory(dir).redirectErrorStream(true).start()
        val text = p.inputStream.bufferedReader().readText()
        if (!p.waitFor(300, TimeUnit.SECONDS)) { p.destroy(); throw IOException("${cmd.first()} timed out") }
        if (p.exitValue() != 0) throw IOException("${cmd.joinToString(" ")} failed:\n${text.takeLast(2000)}")
        return text
    }

    private fun isWindows() = System.getProperty("os.name").lowercase().contains("win")
}
