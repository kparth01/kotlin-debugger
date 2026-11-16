import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compareVersions, installedJdks, javaHomeOnPath } from "../completion/classpath";

/** An installed JDK, described by its `release` file; `java` is never run. */
export interface Jdk {
    /** The directory that has `bin/java`. */
    home: string;
    /** `21.0.4`, `1.8.0_402`; empty when the JDK does not say. */
    version: string;
    /** Feature version: 8, 11, 17, 21, ...; 0 when unknown. */
    major: number;
    vendor?: string;
    /** Where it was found: `JAVA_HOME`, `SDKMAN`, ... */
    source: string;
}

const javaExe = process.platform === "win32" ? "java.exe" : "java";
const javacExe = process.platform === "win32" ? "javac.exe" : "javac";

/** `"21.0.4"` → 21, `"1.8.0_402"` → 8, `"17"` → 17. */
export function majorVersion(version: string): number {
    const m = /^(\d+)(?:\.(\d+))?/.exec(version.trim());
    if (!m) { return 0; }
    const first = parseInt(m[1], 10);
    return first === 1 && m[2] ? parseInt(m[2], 10) : first;
}

/**
 * The JDK at `home` (or in its `Contents/Home`, for a macOS bundle). `undefined` when there is no `bin/javac`:
 * Maven needs a JDK, not a JRE.
 */
export function readJdk(home: string, source: string): Jdk | undefined {
    // A Homebrew prefix and a macOS bundle keep the real home (and its `release` file) further down.
    for (const dir of [path.join(home, "libexec", "openjdk.jdk", "Contents", "Home"), path.join(home, "Contents", "Home"), home]) {
        if (!fs.existsSync(path.join(dir, "bin", javacExe)) || !fs.existsSync(path.join(dir, "bin", javaExe))) { continue; }
        let release = "";
        try { release = fs.readFileSync(path.join(dir, "release"), "utf8"); } catch { /* JDK 8 builds without a release file */ }
        const field = (name: string) => new RegExp(`^${name}="?([^"\\r\\n]*)"?`, "m").exec(release)?.[1];
        const version = field("JAVA_VERSION") ?? /(?:jdk|java|openjdk)[-@_]?(\d[\w.]*)/i.exec(path.basename(home))?.[1] ?? "";
        return { home: dir, version, major: majorVersion(version), vendor: field("IMPLEMENTOR"), source };
    }
    return undefined;
}

function subdirectories(dir: string): string[] {
    try {
        return fs.readdirSync(dir).filter(name => !name.startsWith(".")).map(name => path.join(dir, name));
    } catch {
        return [];
    }
}

/**
 * JDKs on this machine: the given extra homes, `JAVA_HOME`, `java` on `PATH`, the system locations, and the
 * version managers (SDKMAN, asdf, mise, jenv) and IDE downloads (`~/.jdks`, Gradle toolchains). Newest first.
 */
export function discoverJdks(extraHomes: string[] = [], env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Jdk[] {
    const candidates: Array<[string | undefined, string]> = [
        ...extraHomes.map((h): [string, string] => [h, "kotlinDebugger.jdks"]),
        [env.JAVA_HOME, "JAVA_HOME"],
        [javaHomeOnPath(), "PATH"],
        ...installedJdks().map((h): [string, string] => [h, "installed"]),
        ...subdirectories(path.join(env.SDKMAN_DIR ?? path.join(home, ".sdkman"), "candidates", "java")).map((h): [string, string] => [h, "SDKMAN"]),
        ...subdirectories(path.join(env.ASDF_DATA_DIR ?? path.join(home, ".asdf"), "installs", "java")).map((h): [string, string] => [h, "asdf"]),
        ...subdirectories(path.join(home, ".local", "share", "mise", "installs", "java")).map((h): [string, string] => [h, "mise"]),
        ...subdirectories(path.join(home, ".jenv", "versions")).map((h): [string, string] => [h, "jenv"]),
        ...subdirectories(path.join(home, ".jdks")).map((h): [string, string] => [h, "~/.jdks"]),
        // Gradle unpacks a toolchain as `<name>/<jdk-dir>`
        ...subdirectories(path.join(env.GRADLE_USER_HOME ?? path.join(home, ".gradle"), "jdks"))
            .flatMap(h => [h, ...subdirectories(h)]).map((h): [string, string] => [h, "Gradle toolchain"]),
    ];
    const found = new Map<string, Jdk>();
    for (const [candidate, source] of candidates) {
        if (!candidate) { continue; }
        const jdk = readJdk(candidate, source);
        if (!jdk) { continue; }
        let real = jdk.home;
        try { real = fs.realpathSync(jdk.home); } catch { /* keep the given path */ }
        if (!found.has(real)) { found.set(real, jdk); }
    }
    return [...found.values()].sort((a, b) => b.major - a.major || compareVersions(b.version, a.version));
}

/** `JDK 21.0.4 (Eclipse Adoptium)`. */
export function jdkLabel(jdk: Jdk): string {
    return `JDK ${jdk.version || "(unknown version)"}${jdk.vendor ? ` (${jdk.vendor})` : ""}`;
}

/**
 * The Java version a project asks for, and where it says so: compiler properties of the POM (parents included,
 * `properties` has them merged), then `.java-version`, `.sdkmanrc` and `.tool-versions` in the project directory.
 */
export function requiredJavaVersion(properties: Map<string, string>, projectDir?: string): { major: number; source: string } | undefined {
    for (const name of ["maven.compiler.release", "java.version", "maven.compiler.target", "maven.compiler.source", "kotlin.compiler.jvmTarget"]) {
        const major = majorVersion(properties.get(name) ?? "");
        if (major) { return { major, source: `${name} in pom.xml` }; }
    }
    if (!projectDir) { return undefined; }
    const read = (file: string) => {
        try { return fs.readFileSync(path.join(projectDir, file), "utf8"); } catch { return ""; }
    };
    const files: Array<[string, RegExp]> = [
        [".java-version", /^\s*(?:[a-z-]+-)?(\d[\w.]*)/m],
        [".sdkmanrc", /^\s*java\s*=\s*(\d[\w.]*)/m],
        [".tool-versions", /^\s*java\s+(?:[a-z-]+-)?(\d[\w.]*)/m],
    ];
    for (const [file, pattern] of files) {
        const major = majorVersion(pattern.exec(read(file))?.[1] ?? "");
        if (major) { return { major, source: file }; }
    }
    return undefined;
}
