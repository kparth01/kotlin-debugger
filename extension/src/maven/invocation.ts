import * as fs from "fs";
import * as path from "path";

/** Switches that apply to every Maven run started from the view. */
export interface MavenOptions {
    offline: boolean;
    skipTests: boolean;
    updateSnapshots: boolean;
    debugOutput: boolean;
    /** Active profile ids (`-P a,b`). */
    profiles: string[];
    /** `kotlinDebugger.maven.arguments`. */
    extraArgs: string[];
}

export const NO_OPTIONS: MavenOptions = { offline: false, skipTests: false, updateSnapshots: false, debugOutput: false, profiles: [], extraArgs: [] };

export interface MavenExecutable {
    /** The program to start and the arguments that come before Maven's own (`/bin/sh`, `[".../mvnw"]`). */
    command: string;
    prefixArgs: string[];
    /** The `mvn` / `mvnw` script, for messages. */
    script: string;
    source: "setting" | "wrapper" | "bundled" | "PATH";
}

export interface Invocation {
    command: string;
    args: string[];
    cwd: string;
    /** Added to the environment of the Maven process. */
    env: Record<string, string>;
}

function launcher(script: string, source: MavenExecutable["source"], platform: NodeJS.Platform): MavenExecutable {
    // The scripts are started through their interpreter, so a missing executable bit does not matter.
    return platform === "win32"
        ? { command: "cmd.exe", prefixArgs: ["/d", "/c", script], script, source }
        : { command: "/bin/sh", prefixArgs: [script], script, source };
}

/**
 * The Maven to run for a project: `kotlinDebugger.maven.executable` when set, else the project's wrapper (`mvnw` in
 * the project directory or above it, up to `stopDir`), else the Maven bundled with the extension, else `mvn` on `PATH`.
 */
export function findMaven(
    projectDir: string, stopDir: string | undefined, configured: string | undefined, bundledHome: string | undefined,
    env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): MavenExecutable | undefined {
    const windows = platform === "win32";
    const mvn = windows ? "mvn.cmd" : "mvn";
    const isFile = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
    if (configured) {
        const script = [configured, path.join(configured, "bin", mvn), path.join(configured, mvn)].find(isFile);
        return script ? launcher(script, "setting", platform) : undefined;
    }
    for (let dir = projectDir; ; dir = path.dirname(dir)) {
        const wrapper = path.join(dir, windows ? "mvnw.cmd" : "mvnw");
        if (isFile(wrapper)) { return launcher(wrapper, "wrapper", platform); }
        if (dir === stopDir || path.dirname(dir) === dir) { break; }
    }
    if (bundledHome && isFile(path.join(bundledHome, "bin", mvn))) { return launcher(path.join(bundledHome, "bin", mvn), "bundled", platform); }
    // A VS Code started from the Dock does not have the shell's PATH: look in the usual places too.
    const dirs = [...(env.PATH ?? "").split(path.delimiter), ...(windows ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"])];
    const onPath = dirs.filter(Boolean).map(dir => path.join(dir, mvn)).find(isFile);
    return onPath ? launcher(onPath, "PATH", platform) : undefined;
}

/** The process to start for `mvn <goals>` in `cwd`, with `JAVA_HOME` and `PATH` pointing at `jdkHome`. */
export function mavenInvocation(
    maven: MavenExecutable, goals: string[], cwd: string, jdkHome: string, options: MavenOptions = NO_OPTIONS,
    env: NodeJS.ProcessEnv = process.env,
): Invocation {
    const switches = [
        ...(options.offline ? ["-o"] : []),
        ...(options.updateSnapshots ? ["-U"] : []),
        ...(options.debugOutput ? ["-X"] : []),
        ...(options.skipTests ? ["-DskipTests"] : []),
        ...(options.profiles.length ? ["-P", options.profiles.join(",")] : []),
    ];
    return {
        command: maven.command,
        args: [...maven.prefixArgs, ...switches, ...options.extraArgs, ...goals],
        cwd,
        env: { JAVA_HOME: jdkHome, PATH: `${path.join(jdkHome, "bin")}${path.delimiter}${env.PATH ?? ""}` },
    };
}

/** `clean package -Dname="a b"` → `["clean", "package", "-Dname=a b"]`. */
export function splitGoals(line: string): string[] {
    const args: string[] = [];
    let current = "";
    let quote = "";
    let started = false;
    for (const c of line) {
        if (quote) {
            if (c === quote) { quote = ""; } else { current += c; }
        } else if (c === "\"" || c === "'") {
            quote = c;
            started = true;
        } else if (/\s/.test(c)) {
            if (started) { args.push(current); }
            current = "";
            started = false;
        } else {
            current += c;
            started = true;
        }
    }
    if (started) { args.push(current); }
    return args;
}

/**
 * What makes the JVM that runs the code wait for a debugger on `port`: the forked application of `spring-boot:run`,
 * the forked test JVM of Surefire and Failsafe, or Maven's own JVM (`exec:java` and other in-process goals).
 */
export function debugSetup(goals: string[], port: number, env: NodeJS.ProcessEnv = process.env): { args: string[]; env: Record<string, string> } {
    const agent = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port}`;
    const names = goals.filter(g => !g.startsWith("-"));
    if (names.some(g => /(?:^|:)spring-boot(?:-maven-plugin)?(?::[\w.-]+)?:(?:run|test-run)$/.test(g))) {
        return { args: [`-Dspring-boot.run.jvmArguments=${agent}`], env: {} };
    }
    if (names.some(g => ["test", "integration-test", "verify", "install", "deploy", "package"].includes(g) || /(surefire|failsafe):/.test(g))) {
        return { args: [`-Dmaven.surefire.debug=${agent}`, `-Dmaven.failsafe.debug=${agent}`], env: {} };
    }
    return { args: [], env: { MAVEN_OPTS: [env.MAVEN_OPTS, agent].filter(Boolean).join(" ") } };
}

export interface CompilerMessage {
    file: string;
    /** Zero-based. */
    line: number;
    column: number;
    severity: "error" | "warning";
    message: string;
}

const COMPILER_OUTPUT = [
    // Kotlin 2: `[ERROR] file:///abs/File.kt:5:12 Unresolved reference 'x'.`
    /^\[(ERROR|WARNING)\]\s+file:\/\/(?:\/(?=[A-Za-z]:))?(.+?\.kts?):(\d+):(\d+)\s+(.*)$/,
    // Kotlin 1: `[ERROR] /abs/File.kt: (5, 12) Unresolved reference: x`
    /^\[(ERROR|WARNING)\]\s+(.+?\.kts?): \((\d+), (\d+)\)\s+(.*)$/,
    // javac: `[ERROR] /abs/File.java:[5,12] cannot find symbol`
    /^\[(ERROR|WARNING)\]\s+(.+?\.java):\[(\d+),(\d+)\]\s+(.*)$/,
];

/** Kotlin and Java compiler messages in Maven's output (the same lines the task problem matchers pick up), each once. */
export function compilerMessages(output: string): CompilerMessage[] {
    const messages = new Map<string, CompilerMessage>();
    for (const line of output.split(/\r?\n/)) {
        for (const pattern of COMPILER_OUTPUT) {
            const m = pattern.exec(line);
            if (!m) { continue; }
            let file = m[2];
            try { file = decodeURIComponent(file); } catch { /* not URL-encoded */ }
            messages.set(line, { file, line: Number(m[3]) - 1, column: Number(m[4]) - 1, severity: m[1] === "ERROR" ? "error" : "warning", message: m[5] });
            break;
        }
    }
    return [...messages.values()];
}
