import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface JavaRuntime {
    /** Absolute path of the `java` executable. */
    java: string;
    /** Major feature version (17, 21, ...). */
    version: number;
    source: string;
}

const exe = process.platform === "win32" ? "java.exe" : "java";

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<{ code: number | null; out: string }> {
    return new Promise(resolve => {
        cp.execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, out: `${stdout}${stderr}` });
        });
    });
}

function fromHome(home: string | undefined): string | undefined {
    if (!home) { return undefined; }
    const candidates = [path.join(home, "bin", exe), path.join(home, "Contents", "Home", "bin", exe)];
    return candidates.find(c => fs.existsSync(c));
}

function fromPath(): string | undefined {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        const c = path.join(dir, exe);
        if (dir && fs.existsSync(c)) { return c; }
    }
    return undefined;
}

async function macJavaHome(): Promise<string | undefined> {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/libexec/java_home")) { return undefined; }
    const r = await run("/usr/libexec/java_home", ["-v", "17+"]);
    return r.code === 0 ? r.out.trim().split("\n").pop() : undefined;
}

/** Parses `java -version` output: `openjdk version "21.0.4"` / `"1.8.0_402"`. */
export function parseJavaVersion(output: string): number {
    const m = /version "(\d+)(?:\.(\d+))?/.exec(output);
    if (!m) { return 0; }
    const major = parseInt(m[1], 10);
    return major === 1 && m[2] ? parseInt(m[2], 10) : major;
}

async function probe(java: string, source: string): Promise<JavaRuntime | string> {
    const v = await run(java, ["-version"]);
    const version = parseJavaVersion(v.out);
    if (version === 0) { return `${source}: '${java}' is not a working Java executable`; }
    if (version < 17) { return `${source}: '${java}' is Java ${version}; the Kotlin debug adapter needs JDK 17 or newer`; }
    const mods = await run(java, ["--list-modules"]);
    if (!/^jdk\.jdi@/m.test(mods.out)) {
        return `${source}: '${java}' is a JRE without the jdk.jdi module; a full JDK is required`;
    }
    return { java, version, source };
}

let cached: { key: string; runtime: JavaRuntime } | undefined;

/**
 * Finds a JDK 17+ (with jdk.jdi) to run the debug adapter:
 * kotlinDebugger.javaHome setting → JAVA_HOME → java on PATH → macOS java_home.
 */
export async function findJava(configuredHome: string | undefined): Promise<JavaRuntime> {
    const key = `${configuredHome}|${process.env.JAVA_HOME}|${process.env.PATH}`;
    if (cached?.key === key) { return cached.runtime; }
    const problems: string[] = [];
    const candidates: Array<[string | undefined | Promise<string | undefined>, string]> = [
        [fromHome(configuredHome), "kotlinDebugger.javaHome"],
        [fromHome(process.env.JAVA_HOME), "JAVA_HOME"],
        [fromPath(), "PATH"],
        [macJavaHome().then(fromHome), "/usr/libexec/java_home"],
    ];
    for (const [candidate, source] of candidates) {
        const java = await candidate;
        if (!java) { continue; }
        const r = await probe(java, source);
        if (typeof r !== "string") {
            cached = { key, runtime: r };
            return r;
        }
        problems.push(r);
    }
    throw new Error(
        "No suitable JDK found to run the Kotlin debug adapter. Install JDK 17+ and set " +
        "'kotlinDebugger.javaHome' (or JAVA_HOME)." + (problems.length ? `\n${problems.join("\n")}` : "")
    );
}
