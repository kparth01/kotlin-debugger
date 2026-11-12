import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { debugSetup, findMaven, mavenInvocation, NO_OPTIONS, splitGoals } from "../../src/maven/invocation";
import { discoverJdks, jdkLabel, majorVersion, readJdk, requiredJavaVersion } from "../../src/maven/jdks";
import { defaultPrefix, pluginDescriptor, readProject } from "../../src/maven/pomModel";

let tmp: string;

function write(file: string, content = ""): string {
    const full = path.join(tmp, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

/** A directory that looks like a JDK home. */
function fakeJdk(dir: string, release?: string): string {
    write(path.join(dir, "bin", "java"));
    write(path.join(dir, "bin", "javac"));
    if (release !== undefined) { write(path.join(dir, "release"), release); }
    return path.join(tmp, dir);
}

/** A zip with one stored (uncompressed) entry. */
function zip(file: string, entry: string, content: string): string {
    const name = Buffer.from(entry);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + data.length, 16);
    const full = path.join(tmp, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.concat([local, name, data, central, name, end]));
    return full;
}

suite("maven", () => {
    setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kda-maven-")); });
    teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

    suite("JDKs", () => {
        test("feature version of new and old version strings", () => {
            assert.deepStrictEqual(["21.0.4", "17", "1.8.0_402", "11.0.2+9", "", "x"].map(majorVersion), [21, 17, 8, 11, 0, 0]);
        });

        test("a JDK is read from its release file; a JRE or another folder is not a JDK", () => {
            const home = fakeJdk("jdk-21", "IMPLEMENTOR=\"Eclipse Adoptium\"\nJAVA_VERSION=\"21.0.4\"\n");
            const jdk = readJdk(home, "test")!;
            assert.deepStrictEqual({ ...jdk }, { home, version: "21.0.4", major: 21, vendor: "Eclipse Adoptium", source: "test" });
            assert.strictEqual(jdkLabel(jdk), "JDK 21.0.4 (Eclipse Adoptium)");
            write("jre/bin/java");
            assert.strictEqual(readJdk(path.join(tmp, "jre"), "test"), undefined);
            assert.strictEqual(readJdk(path.join(tmp, "missing"), "test"), undefined);
        });

        test("macOS bundle (Contents/Home) and a JDK 8 without a release file", () => {
            fakeJdk("temurin-17.jdk/Contents/Home", "JAVA_VERSION=\"17.0.9\"\n");
            assert.strictEqual(readJdk(path.join(tmp, "temurin-17.jdk"), "test")?.home, path.join(tmp, "temurin-17.jdk", "Contents", "Home"));
            const old = readJdk(fakeJdk("jdk1.8.0_402"), "test")!;
            assert.deepStrictEqual([old.version, old.major], ["1.8.0_402", 8]);
        });

        test("discovery: extra homes, JAVA_HOME, SDKMAN, asdf, jenv, ~/.jdks, Gradle toolchains; each JDK once, newest first", () => {
            const home = path.join(tmp, "home");
            const release = (v: string) => `JAVA_VERSION="${v}"\n`;
            const extra = fakeJdk("extra/jdk-11", release("11.0.20"));
            const javaHome = fakeJdk("home/.sdkman/candidates/java/21.0.4-tem", release("21.0.4"));
            fakeJdk("home/.sdkman/candidates/java/17.0.9-tem", release("17.0.9"));
            fakeJdk("home/.asdf/installs/java/temurin-19.0.2", release("19.0.2"));
            fakeJdk("home/.jdks/corretto-18", release("18.0.2"));
            fakeJdk("home/.gradle/jdks/eclipse_adoptium-22/jdk-22.0.1/Contents/Home", release("22.0.1"));
            fs.mkdirSync(path.join(home, ".jenv", "versions"), { recursive: true });
            fs.symlinkSync(javaHome, path.join(home, ".jenv", "versions", "21.0"));
            const found = discoverJdks([extra], { JAVA_HOME: javaHome, PATH: "" }, home).filter(j => j.home.startsWith(tmp));
            assert.deepStrictEqual(found.map(j => [j.version, j.source]), [
                ["22.0.1", "Gradle toolchain"], ["21.0.4", "JAVA_HOME"], ["19.0.2", "asdf"], ["18.0.2", "~/.jdks"], ["17.0.9", "SDKMAN"],
                ["11.0.20", "kotlinDebugger.jdks"],
            ]);
        });

        test("the Java version a project asks for", () => {
            const props = (entries: Record<string, string>) => new Map(Object.entries(entries));
            assert.deepStrictEqual(requiredJavaVersion(props({ "java.version": "21", "maven.compiler.target": "17" })), { major: 21, source: "java.version in pom.xml" });
            assert.deepStrictEqual(requiredJavaVersion(props({ "maven.compiler.release": "17", "java.version": "21" })), { major: 17, source: "maven.compiler.release in pom.xml" });
            assert.strictEqual(requiredJavaVersion(props({ "maven.compiler.source": "1.8" }))?.major, 8);
            assert.strictEqual(requiredJavaVersion(props({ "java.version": "${unresolved}" })), undefined);
            write("project/.sdkmanrc", "# sdkman\njava=17.0.9-tem\n");
            assert.deepStrictEqual(requiredJavaVersion(props({}), path.join(tmp, "project")), { major: 17, source: ".sdkmanrc" });
            write("other/.java-version", "temurin-21.0\n");
            assert.strictEqual(requiredJavaVersion(props({}), path.join(tmp, "other"))?.major, 21);
        });
    });

    suite("command line", () => {
        test("the Maven to run: setting, then the wrapper of the project or a parent folder, then bundled, then PATH", () => {
            const wrapper = write("ws/mvnw");
            const bundled = path.join(tmp, "bundled");
            write("bundled/bin/mvn");
            const onPath = write("bin/mvn");
            const env = { PATH: path.join(tmp, "bin") };
            const moduleDir = path.join(tmp, "ws", "module");
            fs.mkdirSync(moduleDir);
            const find = (dir: string, configured?: string, bundle?: string) => findMaven(dir, path.join(tmp, "ws"), configured, bundle, env, "darwin");
            assert.deepStrictEqual(find(moduleDir, undefined, bundled), { command: "/bin/sh", prefixArgs: [wrapper], script: wrapper, source: "wrapper" });
            assert.strictEqual(find(moduleDir, bundled, bundled)?.source, "setting", "a Maven home in the setting");
            assert.strictEqual(find(moduleDir, onPath)?.script, onPath, "an mvn script in the setting");
            assert.strictEqual(find(moduleDir, path.join(tmp, "nowhere")), undefined, "a wrong setting is reported, not replaced");
            fs.rmSync(wrapper);
            assert.strictEqual(find(moduleDir, undefined, bundled)?.source, "bundled");
            assert.deepStrictEqual([find(moduleDir)?.source, find(moduleDir)?.script], ["PATH", onPath]);
        });

        test("Windows runs mvnw.cmd through cmd.exe", () => {
            const wrapper = write("ws/mvnw.cmd");
            assert.deepStrictEqual(findMaven(path.join(tmp, "ws"), path.join(tmp, "ws"), undefined, undefined, { PATH: "" }, "win32"),
                { command: "cmd.exe", prefixArgs: ["/d", "/c", wrapper], script: wrapper, source: "wrapper" });
        });

        test("goals run with JAVA_HOME and PATH of the chosen JDK, after the options", () => {
            const maven = { command: "/bin/sh", prefixArgs: ["/p/mvnw"], script: "/p/mvnw", source: "wrapper" as const };
            const plain = mavenInvocation(maven, ["clean", "package"], "/p", "/jdks/21", NO_OPTIONS, { PATH: "/usr/bin" });
            assert.deepStrictEqual(plain, {
                command: "/bin/sh", args: ["/p/mvnw", "clean", "package"], cwd: "/p",
                env: { JAVA_HOME: "/jdks/21", PATH: `${path.join("/jdks/21", "bin")}${path.delimiter}/usr/bin` },
            });
            const all = mavenInvocation(maven, ["verify"], "/p", "/jdks/21",
                { offline: true, skipTests: true, updateSnapshots: true, debugOutput: true, profiles: ["dev", "it"], extraArgs: ["-T", "1C"] }, {});
            assert.deepStrictEqual(all.args, ["/p/mvnw", "-o", "-U", "-X", "-DskipTests", "-P", "dev,it", "-T", "1C", "verify"]);
        });

        test("a typed command line is split like a shell would", () => {
            assert.deepStrictEqual(splitGoals("  clean   package -DskipTests "), ["clean", "package", "-DskipTests"]);
            assert.deepStrictEqual(splitGoals("exec:java -Dexec.args=\"a b\" -Dname='x y' ''"), ["exec:java", "-Dexec.args=a b", "-Dname=x y", ""]);
            assert.deepStrictEqual(splitGoals(""), []);
        });

        test("debugging: the JVM that runs the code waits for the debugger", () => {
            const agent = "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5123";
            assert.deepStrictEqual(debugSetup(["spring-boot:run"], 5123, {}), { args: [`-Dspring-boot.run.jvmArguments=${agent}`], env: {} });
            assert.deepStrictEqual(debugSetup(["org.springframework.boot:spring-boot-maven-plugin:3.5.0:run"], 5123, {}).args, [`-Dspring-boot.run.jvmArguments=${agent}`]);
            assert.deepStrictEqual(debugSetup(["-o", "test"], 5123, {}).args, [`-Dmaven.surefire.debug=${agent}`, `-Dmaven.failsafe.debug=${agent}`]);
            assert.deepStrictEqual(debugSetup(["exec:java"], 5123, { MAVEN_OPTS: "-Xmx1g" }), { args: [], env: { MAVEN_OPTS: `-Xmx1g ${agent}` } });
        });
    });

    suite("pom.xml", () => {
        const pom = (body: string) => `<?xml version="1.0"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n${body}\n</project>\n`;

        test("modules, profiles, and properties inherited from the parent", () => {
            const parent = write("app/pom.xml", pom(`
                <groupId>com.acme</groupId><artifactId>app</artifactId><version>1.2.0</version><packaging>pom</packaging>
                <name>Acme \${project.artifactId}</name>
                <properties><java.version>17</java.version><kotlin.version>2.4.0</kotlin.version></properties>
                <modules><module>api</module><module>missing</module></modules>
                <profiles><profile><id>dev</id></profile></profiles>`));
            const api = write("app/api/pom.xml", pom(`
                <parent><groupId>com.acme</groupId><artifactId>app</artifactId><version>1.2.0</version></parent>
                <artifactId>api</artifactId>
                <properties><java.version>21</java.version><kotlin.target>\${kotlin.version}-\${project.version}</kotlin.target></properties>
                <profiles><profile><id>it</id></profile></profiles>`));
            const root = readProject(parent)!;
            assert.deepStrictEqual([root.name, root.packaging, root.version, root.modules], ["Acme app", "pom", "1.2.0", [api]]);
            assert.deepStrictEqual(root.profiles, ["dev"]);
            const child = readProject(api)!;
            assert.deepStrictEqual([child.groupId, child.artifactId, child.version, child.name, child.packaging], ["com.acme", "api", "1.2.0", "api", "jar"]);
            assert.deepStrictEqual(child.profiles, ["it", "dev"]);
            assert.strictEqual(child.properties.get("java.version"), "21", "the child wins");
            assert.strictEqual(child.properties.get("kotlin.target"), "2.4.0-1.2.0");
            assert.strictEqual(requiredJavaVersion(child.properties)?.major, 21);
            assert.strictEqual(readProject(path.join(tmp, "nothing", "pom.xml")), undefined);
        });

        test("goals come from the plugin's descriptor in its jar", () => {
            const jar = zip("repo/spring-boot-maven-plugin-3.5.0.jar", "META-INF/maven/plugin.xml",
                "<plugin><goalPrefix>spring-boot</goalPrefix><mojos><mojo><goal>run</goal></mojo><mojo><goal>build-image</goal></mojo></mojos></plugin>");
            assert.deepStrictEqual(pluginDescriptor(jar), { prefix: "spring-boot", goals: ["build-image", "run"] });
            assert.strictEqual(pluginDescriptor(zip("repo/other.jar", "x.txt", "x")), undefined);
            assert.strictEqual(pluginDescriptor(path.join(tmp, "repo", "absent.jar")), undefined);
            assert.deepStrictEqual(["maven-surefire-plugin", "spring-boot-maven-plugin", "kotlin-maven-plugin", "exec-plugin"].map(defaultPrefix),
                ["surefire", "spring-boot", "kotlin", "exec"]);
        });
    });
});
