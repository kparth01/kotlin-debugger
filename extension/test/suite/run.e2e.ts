import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Run/Debug lenses on `fun main`, compile on save and Organize Imports, in the Spring Boot sample.
 * Needs a JDK in JAVA_HOME (it becomes the Project JDK) and network access for Maven.
 */
suite("Run, compile on save, organize imports", function () {
    const workspace = process.env.KDA_E2E_WORKSPACE!;
    const pom = vscode.Uri.file(path.join(workspace, "pom.xml"));
    const application = vscode.Uri.file(path.join(workspace, "src/main/kotlin/com/example/demo/DemoApplication.kt"));
    const controller = path.join(workspace, "src/main/kotlin/com/example/demo/web/OrderController.kt");
    const settingsFile = path.join(workspace, ".vscode", "settings.json");
    const hadSettings = fs.existsSync(settingsFile);
    const settings = () => vscode.workspace.getConfiguration("kotlinDebugger", pom);

    suiteSetup(async () => {
        await vscode.extensions.all.find(e => e.packageJSON.name === "kotlin-debugger")!.activate();
        await vscode.commands.executeCommand("kotlinDebugger.selectProjectJdk", process.env.JAVA_HOME);
    });

    suiteTeardown(async () => {
        await settings().update("projectJdk", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        await settings().update("maven.compileOnSave", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        if (!hadSettings && fs.existsSync(settingsFile) && /^\s*\{\s*\}\s*$/.test(fs.readFileSync(settingsFile, "utf8"))) { fs.rmSync(settingsFile); }
    });

    test("Run | Debug above fun main, for the file's facade class", async () => {
        const doc = await vscode.workspace.openTextDocument(application);
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", doc.uri);
        const main = doc.getText().split("\n").findIndex(l => l.startsWith("fun main"));
        const ours = lenses.filter(l => l.command?.command.startsWith("kotlinDebugger."));
        assert.deepStrictEqual(ours.map(l => [l.command!.command, l.range.start.line, l.command!.arguments![1]]), [
            ["kotlinDebugger.runMain", main, "com.example.demo.DemoApplicationKt"],
            ["kotlinDebugger.debugMain", main, "com.example.demo.DemoApplicationKt"],
        ]);
    });

    test("Debug builds the project and starts the main class under the Kotlin debugger", async () => {
        const terminated = new Promise<void>(resolve => {
            const subscription = vscode.debug.onDidTerminateDebugSession(() => { subscription.dispose(); resolve(); });
        });
        const started = await vscode.commands.executeCommand<boolean>(
            "kotlinDebugger.debugMain", application, "com.example.demo.DemoApplicationKt", { env: { PORT: "0" } });
        assert.strictEqual(started, true);
        const session = vscode.debug.activeDebugSession!;
        assert.deepStrictEqual([session.type, session.configuration.request, session.configuration.mainClass], ["kotlin-jvm", "launch", "com.example.demo.DemoApplicationKt"]);
        assert.ok((session.configuration.classPaths as string[]).some(p => p.endsWith(path.join("target", "classes"))), "compiled classes on the classpath");
        assert.ok(String(session.configuration.javaExec).startsWith(settings().get<string>("projectJdk")!), "started with the Project JDK");
        const threads = await session.customRequest("threads");
        assert.ok(threads.threads.length > 0);
        await vscode.debug.stopDebugging(session);
        await terminated;
    });

    test("compile on save: the compiler's error becomes a problem and goes away with the fix", async () => {
        await settings().update("maven.compileOnSave", true, vscode.ConfigurationTarget.WorkspaceFolder);
        const broken = vscode.Uri.file(path.join(workspace, "src/main/kotlin/com/example/demo/OnSave.kt"));
        fs.writeFileSync(broken.fsPath, "package com.example.demo\n\nfun onSave(): Int = 1\n");
        const problems = async (wanted: number) => {
            let found: vscode.Diagnostic[] = [];
            for (let i = 0; i < 240; i++) {
                await new Promise(resolve => setTimeout(resolve, 250));
                found = vscode.languages.getDiagnostics(broken).filter(d => d.source === "kotlinc");
                if (found.length === wanted) { break; }
            }
            return found;
        };
        try {
            const doc = await vscode.workspace.openTextDocument(broken);
            const editor = await vscode.window.showTextDocument(doc);
            await editor.edit(e => e.replace(new vscode.Range(2, 20, 2, 21), "missingName"));
            await doc.save();
            const [problem] = await problems(1);
            assert.ok(problem && /Unresolved reference/.test(problem.message), problem?.message);
            assert.deepStrictEqual([problem.range.start.line, problem.range.start.character, problem.severity], [2, 20, vscode.DiagnosticSeverity.Error]);
            await editor.edit(e => e.replace(new vscode.Range(2, 20, 2, 31), "2"));
            await doc.save();
            assert.deepStrictEqual(await problems(0), [], "fixed");
        } finally {
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            fs.rmSync(broken.fsPath, { force: true });
        }
    });

    test("Organize Imports sorts by the layout and drops duplicates and unused imports", async () => {
        const doc = await vscode.workspace.openTextDocument(controller);
        const editor = await vscode.window.showTextDocument(doc);
        const first = doc.getText().split("\n").findIndex(l => l.startsWith("import "));
        const original = doc.getText().split("\n").filter(l => l.startsWith("import "));
        try {
            await editor.edit(e => e.insert(new vscode.Position(first, 0),
                "import java.util.UUID\nimport org.springframework.http.HttpStatus\nimport kotlin.math.max\nimport com.example.demo.domain.itemCount\n"));
            const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                "vscode.executeCodeActionProvider", doc.uri, new vscode.Range(0, 0, 0, 0), "source.organizeImports");
            assert.deepStrictEqual(actions.map(a => a.title), ["Organize Imports"], "offered as source.organizeImports (Kotlin Jump is not installed here)");
            await vscode.commands.executeCommand("kotlinDebugger.organizeImports");
            assert.deepStrictEqual(doc.getText().split("\n").filter(l => l.startsWith("import ")), original, "back to the sorted imports of the file");
        } finally {
            await vscode.commands.executeCommand("workbench.action.files.revert");
        }
    });
});
