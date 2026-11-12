import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

/**
 * False-positive check for the missing-import detection on a project that compiles:
 *   KDA_E2E_SUITE=importSweep KDA_E2E_WORKSPACE=/path/to/project node out/test/runE2E.js
 * Lists every name the extension would offer to import. On code that compiles there should be none.
 */
suite("Import sweep: a compiling project needs no imports", function () {
    test("no Import quick fix in any Kotlin file of the workspace", async () => {
        const files = await vscode.workspace.findFiles("**/*.kt", "**/{target,build,node_modules,out}/**");
        assert.ok(files.length > 0, "Kotlin files in the workspace");
        const found: string[] = [];
        for (const file of files) {
            const doc = await vscode.workspace.openTextDocument(file);
            const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                "vscode.executeCodeActionProvider", doc.uri, new vscode.Range(0, 0, doc.lineCount, 0));
            for (const a of actions.filter(action => action.title.startsWith("Import "))) {
                found.push(`${path.relative(process.env.KDA_E2E_WORKSPACE ?? "", file.fsPath)}: ${a.title}`);
            }
        }
        console.log(`Swept ${files.length} Kotlin files`);
        assert.deepStrictEqual(found, []);
    });
});
