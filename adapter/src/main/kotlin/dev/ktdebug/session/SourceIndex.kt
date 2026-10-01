package dev.ktdebug.session

import dev.ktdebug.util.Log
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.ConcurrentHashMap

/**
 * Index of the local Kotlin/Java sources.
 *
 * The JVM only knows a class's *source file name* and its *package*; it does not know where the
 * file lives on this machine (the app may have been built elsewhere, e.g. in CI or a container).
 * We therefore map `(package, file name)` <-> local path, which works for remote attach as long as
 * the workspace contains the same sources. Kotlin does not require the directory layout to match
 * the package, so the package is read from each file's `package` directive.
 */
class SourceIndex(private val roots: List<Path>) {
    data class SourceFile(val path: Path, val packageName: String, val fileName: String, val jvmName: String? = null) {
        val packageDir: String get() = packageName.replace('.', '/')

        /** JVM class holding this file's top-level functions/properties (`OrdersKt`). */
        val facadeClass: String
            get() {
                val simple = jvmName ?: (fileName.removeSuffix(".kt").replaceFirstChar { it.uppercaseChar() }
                    .map { if (it.isLetterOrDigit() || it == '_') it else '_' }.joinToString("") + "Kt")
                return if (packageName.isEmpty()) simple else "$packageName.$simple"
            }
    }

    private val byKey = ConcurrentHashMap<String, MutableList<Path>>()   // "com/x/Foo.kt"
    private val byName = ConcurrentHashMap<String, MutableList<Path>>()  // "Foo.kt"
    private val parsed = ConcurrentHashMap<Path, Pair<Long, SourceFile>>()
    private val packages = ConcurrentHashMap.newKeySet<String>()

    /** Packages declared by project sources; used for "just my code" style decisions. */
    val projectPackages: Set<String> get() = packages

    @Volatile var fileCount = 0
        private set

    fun build(): SourceIndex {
        val start = System.currentTimeMillis()
        for (root in roots.distinct()) {
            if (!Files.isDirectory(root)) continue
            try {
                Files.walkFileTree(root, object : SimpleFileVisitor<Path>() {
                    override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                        val name = dir.fileName?.toString() ?: return FileVisitResult.CONTINUE
                        return if (dir != root && name in SKIPPED_DIRS) FileVisitResult.SKIP_SUBTREE else FileVisitResult.CONTINUE
                    }

                    override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                        val n = file.fileName.toString()
                        if (n.endsWith(".kt") || n.endsWith(".java")) add(file)
                        return if (fileCount > MAX_FILES) FileVisitResult.TERMINATE else FileVisitResult.CONTINUE
                    }

                    override fun visitFileFailed(file: Path, exc: java.io.IOException) = FileVisitResult.CONTINUE
                })
            } catch (e: Exception) {
                Log.warn("Failed to index sources under $root", e)
            }
        }
        Log.info("Indexed $fileCount source files in ${packages.size} packages under ${roots.joinToString()} (${System.currentTimeMillis() - start} ms)")
        return this
    }

    private fun add(file: Path) {
        val info = info(file) ?: return
        fileCount++
        byKey.computeIfAbsent(key(info.packageDir, info.fileName)) { mutableListOf() }.add(info.path)
        byName.computeIfAbsent(info.fileName) { mutableListOf() }.add(info.path)
        packages.add(info.packageName)
    }

    /** Parses (and caches) the package of a source file. Works for files outside the roots too. */
    fun info(file: Path): SourceFile? {
        val path = file.toAbsolutePath().normalize()
        val modified = runCatching { Files.getLastModifiedTime(path).toMillis() }.getOrDefault(0L)
        parsed[path]?.let { (mtime, info) -> if (mtime == modified) return info }
        val text = runCatching { Files.readString(path) }.getOrElse {
            runCatching { String(Files.readAllBytes(path), Charsets.ISO_8859_1) }.getOrNull()
        } ?: return null
        val info = SourceFile(path, parsePackage(text), path.fileName.toString(), JVM_NAME.find(text.take(16_384))?.groupValues?.get(1))
        parsed[path] = modified to info
        if (info.packageName.isNotEmpty()) packages.add(info.packageName)
        return info
    }

    /** Indexed Kotlin files (for top-level/extension function lookup during evaluation). */
    fun kotlinFiles(): List<SourceFile> =
        byName.values.flatten().filter { it.toString().endsWith(".kt") }.mapNotNull { parsed[it.toAbsolutePath().normalize()]?.second }

    /** Cheap text search used to narrow candidate files (content cached by modification time). */
    fun fileMentions(file: SourceFile, word: String): Boolean {
        val text = runCatching { Files.readString(file.path) }.getOrNull() ?: return false
        return Regex("\\b${Regex.escape(word)}\\b").containsMatchIn(text)
    }

    /**
     * Finds the local file for a JVM source position: the file name plus the package directory
     * reported by the class (may be null/unknown). Falls back to a unique file-name match.
     */
    fun resolve(packageDir: String?, fileName: String): Path? {
        if (packageDir != null) {
            byKey[key(packageDir, fileName)]?.let { return pickBest(it) }
        }
        val candidates = byName[fileName] ?: return null
        return if (candidates.size == 1 || packageDir == null) pickBest(candidates) else null
    }

    private fun pickBest(paths: List<Path>): Path =
        paths.firstOrNull { it.toString().replace('\\', '/').contains("/src/main/") } ?: paths.first()

    private fun key(packageDir: String, fileName: String) =
        if (packageDir.isEmpty()) fileName else "$packageDir/$fileName"

    companion object {
        private const val MAX_FILES = 300_000
        val SKIPPED_DIRS = setOf(
            ".git", ".gradle", ".idea", ".vscode", ".svn", ".hg", "node_modules", "build", "target",
            "out", ".kotlin", ".mvn", "dist", "bin", ".settings"
        )

        private val BLOCK_COMMENT = Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL)
        private val LINE_COMMENT = Regex("//[^\\n]*")
        private val PACKAGE = Regex("^\\s*package\\s+([\\w.`]+)", RegexOption.MULTILINE)
        private val JVM_NAME = Regex("@file\\s*:\\s*JvmName\\s*\\(\\s*\"([^\"]+)\"")

        fun parsePackage(text: String): String {
            // Only the header matters; keep this cheap for large files.
            val head = text.take(16_384).replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, " ")
            val m = PACKAGE.find(head) ?: return ""
            return m.groupValues[1].replace("`", "").trimEnd(';')
        }

        fun of(vararg roots: String) = SourceIndex(roots.map { Paths.get(it) }).build()
    }
}
