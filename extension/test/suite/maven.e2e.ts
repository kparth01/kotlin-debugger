import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

interface Project { file: string; dir: string; name: string; artifactId: string; modules: string[]; properties: Map<string, string> }
interface Plugin { prefix: string; goals: string[] }
interface MavenApi {
    projects(): Promise<Project[]>;
    plugins(pomFile: string): Plugin[];
    run(pomFile: string, goals: string[], debug?: boolean): Promise<number | undefined>;
}

/**
 * The Maven view against the Spring Boot sample: the project model, runs with the Project JDK, compiler errors in
 * the Problems panel, and debugging `spring-boot:run`. Needs a JDK in JAVA_HOME and network access for Maven.
 */
suite("Maven view", function () {
    const workspace = process.env.KDA_E2E_WORKSPACE!;
    const pom = path.join(workspace, "pom.xml");
    const settingsFile = path.join(workspace, ".vscode", "settings.json");
    const hadSettings = fs.existsSync(settingsFile);
    const jdkHome = process.env.JAVA_HOME!;
    let maven: MavenApi;

    suiteSetup(async () => {
        assert.ok(jdkHome, "JAVA_HOME must point at the JDK to select");
        const extension = vscode.extensions.all.find(e => e.packageJSON.name === "kotlin-debugger")!;
        maven = (await extension.activate()).maven;
    });

    suiteTeardown(async () => {
        await vscode.workspace.getConfiguration("kotlinDebugger", vscode.Uri.file(pom)).update("projectJdk", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        if (!hadSettings && fs.existsSync(settingsFile) && /^\s*\{\s*\}\s*$/.test(fs.readFileSync(settingsFile, "utf8"))) { fs.rmSync(settingsFile); }
    });

    test("the project, its Java version and the goals of its plugins", async () => {
        const projects = await maven.projects();
        assert.deepStrictEqual(projects.map(p => [p.artifactId, p.name, p.file]), [["spring-boot-kotlin-demo", "Spring Boot Kotlin debugging demo", pom]]);
        assert.strictEqual(projects[0].properties.get("java.version"), "21");
        const plugins = new Map(maven.plugins(pom).map(p => [p.prefix, p.goals]));
        assert.ok(plugins.get("spring-boot")?.includes("run") && plugins.get("spring-boot")?.includes("repackage"), [...plugins.keys()].join(", "));
        assert.ok(plugins.get("kotlin")?.includes("compile"), JSON.stringify(plugins.get("kotlin")));
    });

    test("Select Project JDK saves the choice for the folder; Maven runs on that JDK", async () => {
        await vscode.commands.executeCommand("kotlinDebugger.selectProjectJdk", jdkHome);
        const saved = vscode.workspace.getConfiguration("kotlinDebugger", vscode.Uri.file(pom)).get<string>("projectJdk")!;
        // a Homebrew prefix or a macOS bundle is saved as the real home inside it
        assert.ok(fs.realpathSync(saved).startsWith(fs.realpathSync(jdkHome)) && fs.existsSync(path.join(saved, "bin", "javac")), saved);
        assert.ok(JSON.parse(fs.readFileSync(settingsFile, "utf8"))["kotlinDebugger.projectJdk"], "in .vscode/settings.json of the folder");
        // -V prints the runtime Maven uses; -l sends it to a file the test can read
        const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kda-mvn-")), "maven.log");
        assert.strictEqual(await maven.run(pom, ["-V", "-l", log, "validate"]), 0, fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "no log");
        const runtime = /^Java version: .*runtime: (.+)$/m.exec(fs.readFileSync(log, "utf8"))?.[1];
        assert.strictEqual(runtime && fs.realpathSync(runtime), fs.realpathSync(saved));
    });

    test("a Kotlin compiler error of a Maven run appears in the Problems panel", async () => {
        const broken = path.join(workspace, "src/main/kotlin/com/example/demo/Broken.kt");
        fs.writeFileSync(broken, "package com.example.demo\n\nfun broken(): Int {\n    return missingName + 1\n}\n");
        try {
            assert.notStrictEqual(await maven.run(pom, ["compile"]), 0, "the build fails");
            let problems: vscode.Diagnostic[] = [];
            for (let i = 0; i < 20 && !problems.length; i++) {
                await new Promise(resolve => setTimeout(resolve, 250));
                problems = vscode.languages.getDiagnostics(vscode.Uri.file(broken));
            }
            assert.ok(problems.length, "a problem on Broken.kt");
            const [problem] = problems;
            assert.ok(/Unresolved reference/.test(problem.message), problem.message);
            assert.deepStrictEqual([problem.range.start.line, problem.range.start.character, problem.severity], [3, 11, vscode.DiagnosticSeverity.Error]);
        } finally {
            fs.rmSync(broken);
        }
    });

    test("Debug on spring-boot:run attaches the Kotlin debugger; stopping it stops Maven", async () => {
        const started = new Promise<vscode.DebugSession>(resolve => {
            const subscription = vscode.debug.onDidStartDebugSession(session => { subscription.dispose(); resolve(session); });
        });
        const run = maven.run(pom, ["spring-boot:run", "-Dspring-boot.run.arguments=--server.port=0"], true);
        const session = await started;
        assert.deepStrictEqual([session.type, session.configuration.request], ["kotlin-jvm", "attach"]);
        assert.ok(session.name.startsWith("Debug: mvn spring-boot:run"), session.name);
        const threads = await session.customRequest("threads");
        assert.ok(threads.threads.length > 0, "attached to the application JVM");
        await vscode.debug.stopDebugging(session);
        const exit = await run;
        assert.notStrictEqual(exit, 0, "Maven was stopped with the session");
    });
});
