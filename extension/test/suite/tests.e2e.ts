import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface TestsApi {
    discovered(): Promise<Array<{ pom: string; file: string; fqName: string; methods: string[] }>>;
    run(pomFile: string, tests: Array<{ fqName: string; methods?: string[] }>, debug?: boolean):
        Promise<{ exitCode: number | undefined; results: Record<string, Record<string, string> | "errored"> }>;
}

/**
 * Kotlin tests through Maven, in a project with JUnit 5 tests (the debug adapter itself):
 *   KDA_E2E_SUITE=tests KDA_E2E_WORKSPACE=<repo>/adapter node out/test/runE2E.js
 */
suite("Kotlin tests through Maven", function () {
    const workspace = process.env.KDA_E2E_WORKSPACE!;
    const pom = path.join(workspace, "pom.xml");
    const settingsFile = path.join(workspace, ".vscode", "settings.json");
    const hadSettings = fs.existsSync(settingsFile);
    const hadFolder = fs.existsSync(path.dirname(settingsFile));
    const temporary = path.join(workspace, "src/test/kotlin/dev/ktdebug/TemporaryE2eTest.kt");
    let tests: TestsApi;

    suiteSetup(async () => {
        tests = (await vscode.extensions.all.find(e => e.packageJSON.name === "kotlin-debugger")!.activate()).tests;
        await vscode.commands.executeCommand("kotlinDebugger.selectProjectJdk", process.env.JAVA_HOME);
    });

    suiteTeardown(async () => {
        fs.rmSync(temporary, { force: true });
        await vscode.workspace.getConfiguration("kotlinDebugger", vscode.Uri.file(pom)).update("projectJdk", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        if (!hadSettings && fs.existsSync(settingsFile) && /^\s*\{\s*\}\s*$/.test(fs.readFileSync(settingsFile, "utf8"))) { fs.rmSync(settingsFile); }
        if (!hadFolder && fs.existsSync(path.dirname(settingsFile)) && !fs.readdirSync(path.dirname(settingsFile)).length) { fs.rmdirSync(path.dirname(settingsFile)); }
    });

    test("test classes and methods are found, with backticked names", async () => {
        const found = await tests.discovered();
        const parser = found.find(t => t.fqName === "dev.ktdebug.ParserTest");
        assert.ok(parser, found.map(t => t.fqName).join(", "));
        assert.strictEqual(parser.pom, pom);
        assert.ok(parser.methods.includes("kotlin precedence") && parser.methods.includes("member chains, calls, index and safe calls"), parser.methods.join(" | "));
        assert.ok(found.some(t => t.fqName === "dev.ktdebug.HitConditionTest"));
    });

    test("selected methods run through Maven; passed and failed results come from the Surefire report", async () => {
        fs.writeFileSync(temporary, [
            "package dev.ktdebug", "",
            "import org.junit.jupiter.api.Assertions.assertEquals", "import org.junit.jupiter.api.Test", "",
            "class TemporaryE2eTest {",
            "    @Test fun `two plus two, checked`() = assertEquals(4, 2 + 2)",
            "    @Test fun wrong() = assertEquals(5, 2 + 2)",
            "    @Test fun notSelected() = assertEquals(1, 2)",
            "}", "",
        ].join("\n"));
        const { exitCode, results } = await tests.run(pom, [
            { fqName: "dev.ktdebug.ParserTest", methods: ["kotlin precedence", "member chains, calls, index and safe calls"] },
            { fqName: "dev.ktdebug.TemporaryE2eTest", methods: ["two plus two, checked", "wrong"] },
        ]);
        assert.deepStrictEqual(results["dev.ktdebug.ParserTest"], { "kotlin precedence": "passed", "member chains, calls, index and safe calls": "passed" });
        assert.deepStrictEqual(results["dev.ktdebug.TemporaryE2eTest"], { "two plus two, checked": "passed", "wrong": "failed" }, "only the selected methods ran");
        assert.notStrictEqual(exitCode, 0, "a failed test fails the build");
    });
});
