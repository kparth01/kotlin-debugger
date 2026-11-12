import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

/**
 * `ClassName.` / `package.` completion in the Spring Boot sample: classes come from the JDK image, the jars of the
 * Maven dependencies (resolved from pom.xml + ~/.m2) and target/classes. The sample must have been built once.
 */
suite("Completion: class members and packages", function () {
    const workspace = process.env.KDA_E2E_WORKSPACE!;
    const controller = path.join(workspace, "src/main/kotlin/com/example/demo/web/OrderController.kt");

    /** Completion items at the end of `line`, appended (unsaved) to `file`; overloads are separate items. */
    async function complete(file: string, line: string): Promise<vscode.CompletionItem[]> {
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc);
        await editor.edit(e => e.insert(doc.lineAt(doc.lineCount - 1).range.end, `\n${line}`));
        const position = doc.lineAt(doc.lineCount - 1).range.end;
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            "vscode.executeCompletionItemProvider", doc.uri, position, ".");
        await vscode.commands.executeCommand("workbench.action.files.revert");
        return list.items;
    }

    /** Completion items at the end of `lines`, inserted (unsaved) after the line containing `marker`. */
    async function completeAfter(file: string, marker: string, lines: string[]): Promise<vscode.CompletionItem[]> {
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc);
        const line = doc.getText().split("\n").findIndex(l => l.includes(marker));
        assert.ok(line >= 0, marker);
        await editor.edit(e => e.insert(doc.lineAt(line).range.end, lines.map(l => `\n        ${l}`).join("")));
        const position = doc.lineAt(line + lines.length).range.end;
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            "vscode.executeCompletionItemProvider", doc.uri, position, ".");
        await vscode.commands.executeCommand("workbench.action.files.revert");
        return list.items;
    }

    const name = (i: vscode.CompletionItem) => typeof i.label === "string" ? i.label : i.label.label;
    const names = (items: vscode.CompletionItem[]) => new Set(items.map(name));
    /** `name(params): Type` of every overload called `label`. */
    const signatures = (items: vscode.CompletionItem[], label: string) => items
        .filter(i => name(i) === label && typeof i.label !== "string")
        .map(i => { const l = i.label as vscode.CompletionItemLabel; return `${l.label}${l.detail ?? ""}: ${l.description}`; });

    test("imported library class (Spring): enum constants and static methods with parameter names", async () => {
        const items = await complete(controller, "val status = HttpStatus.");
        assert.ok(names(items).has("NOT_FOUND"), "enum constant");
        assert.ok(signatures(items, "valueOf").includes("valueOf(statusCode: Int): HttpStatus"), signatures(items, "valueOf").join(" | "));
        assert.ok(items.every(i => !i.additionalTextEdits), "HttpStatus is already imported");
    });

    test("JDK class through Kotlin's default java.lang import", async () => {
        const items = await complete(controller, "val x = Math.");
        assert.ok(signatures(items, "max").includes("max(a: Int, b: Int): Int"), signatures(items, "max").join(" | "));
        assert.ok(names(items).has("PI"));
    });

    test("class that is not imported yet: completion adds the import", async () => {
        const items = await complete(controller, "val blank = StringUtils.");
        const hasText = items.find(i => name(i) === "hasText"
            && i.additionalTextEdits?.[0].newText === "import org.springframework.util.StringUtils\n");
        assert.ok(hasText, "StringUtils.hasText from spring-core, with auto-import");
    });

    test("Kotlin object members are properties", async () => {
        const items = await complete(controller, "val d = kotlinx.coroutines.Dispatchers.");
        assert.ok(names(items).has("Default") && names(items).has("IO"), [...names(items)].join(", "));
        assert.ok(!names(items).has("getDefault"));
    });

    test("project class: companion const val", async () => {
        const items = await complete(controller, "val n = com.example.demo.service.PricingService.");
        assert.ok(names(items).has("BULK_THRESHOLD"), [...names(items)].join(", "));
    });

    const create = "@bp:controller-create";

    test("variable: members of ArrayList<String> as Kotlin sees them, plus stdlib extensions", async () => {
        const items = await completeAfter(controller, create, ["val li = ArrayList<String>()", "li."]);
        const n = names(items);
        for (const expected of ["add", "removeAt", "size", "subList", "ensureCapacity", "map", "filter", "joinToString", "forEach"]) {
            assert.ok(n.has(expected), `${expected} in ${[...n].join(", ")}`);
        }
        assert.ok(!n.has("getClass") && !n.has("toArray"), "JDK methods Kotlin hides");
        assert.ok(signatures(items, "add").includes("add(element: String): Boolean"), signatures(items, "add").join(" | "));
        assert.ok(signatures(items, "map").includes("map(transform: (String) -> R): List<R>"), signatures(items, "map").join(" | "));
        const map = items.find(i => name(i) === "map")!;
        // snippet syntax escapes `}`; VS Code inserts `map {  }` with the cursor inside the braces
        assert.strictEqual((map.insertText as vscode.SnippetString).value.replace(/\\}/g, "}"), "map { $0 }");
    });

    test("read-only List has no mutators; chains through calls and properties", async () => {
        const lines = names(await completeAfter(controller, create, ["request.lines."]));
        assert.ok(lines.has("size") && lines.has("first") && !lines.has("add"), [...lines].join(", "));
        const line = names(await completeAfter(controller, create, ["orders.findOrder(1).lines.first()."]));
        assert.ok(line.has("productId") && line.has("unitPrice") && line.has("copy"), [...line].join(", "));
    });

    test("lambda result types flow into the chain: map { it.unitPrice } is List<BigDecimal>", async () => {
        const items = await completeAfter(controller, create, ["request.lines.map { it.unitPrice }.first()."]);
        assert.ok(names(items).has("setScale") && names(items).has("toDouble"), [...names(items)].join(", "));
    });

    test("extension property from another package of the project is offered with its import", async () => {
        const items = await completeAfter(controller, create, ["order."]);
        const itemCount = items.find(i => name(i) === "itemCount");
        assert.ok(itemCount, [...names(items)].join(", "));
        assert.strictEqual(itemCount.additionalTextEdits?.[0].newText, "import com.example.demo.domain.itemCount\n");
    });

    test("code that is not compiled yet: a class typed in the editor completes immediately", async () => {
        const doc = await vscode.workspace.openTextDocument(controller);
        const editor = await vscode.window.showTextDocument(doc);
        const line = doc.getText().split("\n").findIndex(l => l.includes(create));
        await editor.edit(e => {
            e.insert(doc.lineAt(doc.lineCount - 1).range.end,
                "\nclass Draft(val title: String) {\n    fun words() = title.split(\" \")\n    companion object { fun blank() = Draft(\"\") }\n}\n");
            e.insert(doc.lineAt(line).range.end, "\n        Draft.blank().words().first().");
        });
        const position = doc.lineAt(line + 1).range.end;
        const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, position, ".");
        await vscode.commands.executeCommand("workbench.action.files.revert");
        const n = names(list.items);
        assert.ok(n.has("length") && n.has("uppercase") && n.has("substringBefore"), [...n].join(", "));
    });

    test("parameter hints: overloads of the called function and the active argument", async () => {
        const doc = await vscode.workspace.openTextDocument(controller);
        const editor = await vscode.window.showTextDocument(doc);
        const line = doc.getText().split("\n").findIndex(l => l.includes(create));
        await editor.edit(e => e.insert(doc.lineAt(line).range.end, "\n        request.lines.joinToString(\", \", "));
        const help = await vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", doc.uri, doc.lineAt(line + 1).range.end, ",");
        await editor.edit(e => e.insert(doc.lineAt(line + 1).range.end, "postfix = "));
        const named = await vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", doc.uri, doc.lineAt(line + 1).range.end, ",");
        await vscode.commands.executeCommand("workbench.action.files.revert");
        const signature = help.signatures[help.activeSignature];
        assert.ok(signature.label.startsWith("joinToString(separator: CharSequence = …, prefix: CharSequence = …"), signature.label);
        assert.strictEqual(help.activeParameter, 1);
        assert.strictEqual(named.activeParameter, 2, "postfix = … is the third parameter");
    });

    test("ClassName. of a class that exists only in the editor", async () => {
        const doc = await vscode.workspace.openTextDocument(controller);
        const editor = await vscode.window.showTextDocument(doc);
        const line = doc.getText().split("\n").findIndex(l => l.includes(create));
        await editor.edit(e => {
            e.insert(doc.lineAt(doc.lineCount - 1).range.end, "\nenum class Shade { LIGHT, DARK }\n");
            e.insert(doc.lineAt(line).range.end, "\n        Shade.");
        });
        const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, doc.lineAt(line + 1).range.end, ".");
        await vscode.commands.executeCommand("workbench.action.files.revert");
        const n = names(list.items);
        assert.ok(n.has("LIGHT") && n.has("DARK") && n.has("entries"), [...n].join(", "));
    });

    test("without a dot: locals, members of this, top-level functions, classes (with auto-import), named arguments", async () => {
        async function at(line: string): Promise<vscode.CompletionItem[]> {
            const doc = await vscode.workspace.openTextDocument(controller);
            const editor = await vscode.window.showTextDocument(doc);
            const marker = doc.getText().split("\n").findIndex(l => l.includes(create));
            const [head] = line.split("¦");
            await editor.edit(e => e.insert(doc.lineAt(marker).range.end, `\n        ${line.replace("¦", "")}`));
            const position = new vscode.Position(marker + 1, 8 + head.length);
            const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, position);
            await vscode.commands.executeCommand("workbench.action.files.revert");
            return list.items;
        }
        const ord = await at("ord¦");
        const order = ord.find(i => name(i) === "order");
        assert.ok(order && (order.label as vscode.CompletionItemLabel).description === "Order", [...names(ord)].join(", "));
        assert.ok(names(ord).has("orders"), "constructor property of the class");
        assert.ok(names(await at("lis¦")).has("listOf"));
        const stringUtils = (await at("StringU¦")).find(i => name(i) === "StringUtils");
        assert.ok(stringUtils?.additionalTextEdits?.[0].newText.startsWith("import "), "class that is not imported");
        const named = names(await at("request.copy(¦)"));
        assert.ok(named.has("customerId =") && named.has("lines ="), [...named].join(", "));
    });

    /** Completion items at `¦` in `line`, inserted (unsaved) after the line containing the create marker. */
    async function atCursor(line: string): Promise<vscode.CompletionItem[]> {
        const doc = await vscode.workspace.openTextDocument(controller);
        const editor = await vscode.window.showTextDocument(doc);
        const marker = doc.getText().split("\n").findIndex(l => l.includes(create));
        const [head] = line.split("¦");
        await editor.edit(e => e.insert(doc.lineAt(marker).range.end, `\n        ${line.replace("¦", "")}`));
        const position = new vscode.Position(marker + 1, 8 + head.length);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, position);
        await vscode.commands.executeCommand("workbench.action.files.revert");
        return list.items;
    }

    test("a new import goes to its sorted place (IntelliJ layout), not below the last import", async () => {
        const text = (await vscode.workspace.openTextDocument(controller)).getText().split("\n");
        const lineOf = (statement: string) => { const i = text.indexOf(statement); assert.ok(i >= 0, statement); return i; };
        const hasText = (await complete(controller, "val blank = StringUtils.")).find(i => name(i) === "hasText" && i.additionalTextEdits);
        assert.ok(hasText, "StringUtils.hasText with an import");
        // org.springframework.util sorts between org.springframework.http and org.springframework.web
        assert.strictEqual(hasText.additionalTextEdits![0].range.start.line, lineOf("import org.springframework.http.ProblemDetail") + 1);
        const itemCount = (await completeAfter(controller, create, ["order."])).find(i => name(i) === "itemCount");
        assert.strictEqual(itemCount?.additionalTextEdits?.[0].range.start.line, lineOf("import com.example.demo.domain.OrderRequest") + 1);
        const uuid = (await atCursor("UUI¦")).find(i => name(i) === "UUID");
        assert.strictEqual(uuid?.additionalTextEdits?.[0].newText, "import java.util.UUID\n");
        assert.strictEqual(uuid.additionalTextEdits[0].range.start.line, lineOf("import java.math.BigDecimal") + 1, "java.* stays below the other imports");
    });

    test("a class whose name is taken in the file is inserted fully qualified, without an import", async () => {
        const orders = (await atCursor("Orde¦")).filter(i => name(i) === "Order");
        const text = (i: vscode.CompletionItem) => typeof i.insertText === "string" ? i.insertText : i.insertText?.value;
        const imported = orders.find(i => text(i) === "Order");
        assert.ok(imported && !imported.additionalTextEdits, "the imported com.example.demo.domain.Order");
        const spring = orders.find(i => text(i) === "org.springframework.core.annotation.Order");
        assert.ok(spring, orders.map(text).join(", "));
        assert.ok(!spring.additionalTextEdits, "no import: it would hide the imported Order");
        assert.strictEqual((spring.label as vscode.CompletionItemLabel).description, "org.springframework.core.annotation");
        // java.util.List is Kotlin's List: it is not offered as a second, qualified `List`
        const lists = (await atCursor("Lis¦")).filter(i => name(i) === "List").map(text);
        assert.ok(lists.includes("List") && !lists.includes("java.util.List"), lists.join(", "));
    });

    test("the same extension in two packages: both are offered, each with its own import", async () => {
        const extra = path.join(workspace, "src/main/kotlin/com/example/demo/extra/Extra.kt");
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(extra)));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(extra), Buffer.from(
            "package com.example.demo.extra\n\nimport com.example.demo.domain.Order\n\nval Order.itemCount: Int get() = 0\n"));
        // the file reaches (and leaves) the index through the file watcher
        const itemCountImports = async (expected: number) => {
            let imports: string[] = [];
            for (let i = 0; i < 40 && imports.length !== expected; i++) {
                await new Promise(resolve => setTimeout(resolve, 250));
                imports = (await completeAfter(controller, create, ["order."]))
                    .filter(item => name(item) === "itemCount").map(item => item.additionalTextEdits?.[0].newText ?? "").sort();
            }
            return imports;
        };
        try {
            assert.deepStrictEqual(await itemCountImports(2), ["import com.example.demo.domain.itemCount\n", "import com.example.demo.extra.itemCount\n"]);
        } finally {
            await vscode.workspace.fs.delete(vscode.Uri.file(path.dirname(extra)), { recursive: true });
        }
        // deleting the folder is one event for the folder, none for the file in it
        assert.deepStrictEqual(await itemCountImports(1), ["import com.example.demo.domain.itemCount\n"], "the files of a deleted folder are forgotten");
    });

    suite("imports for typed or pasted code", () => {
        const typed = [
            "val id = UUID.randomUUID()",
            "val day = Date()",
            "val n = runBlocking { order.itemCount }",
            "val text = \"UUID in a string\" // and Date in a comment",
        ];

        /** Opens the controller with `lines` inserted (unsaved) below the create marker. */
        async function withLines(lines: string[]): Promise<{ doc: vscode.TextDocument; editor: vscode.TextEditor; first: number }> {
            const doc = await vscode.workspace.openTextDocument(controller);
            const editor = await vscode.window.showTextDocument(doc);
            const marker = doc.getText().split("\n").findIndex(l => l.includes(create));
            await editor.edit(e => e.insert(doc.lineAt(marker).range.end, lines.map(l => `\n        ${l}`).join("")));
            return { doc, editor, first: marker + 1 };
        }

        const rangeOf = (doc: vscode.TextDocument, line: number, word: string) => {
            const at = doc.lineAt(line).text.indexOf(word);
            assert.ok(at >= 0, word);
            return new vscode.Range(line, at, line, at + word.length);
        };

        const importsAt = async (doc: vscode.TextDocument, range: vscode.Range) =>
            (await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", doc.uri, range))
                .filter(a => a.title.startsWith("Import "));

        teardown(() => vscode.commands.executeCommand("workbench.action.files.revert"));

        test("quick fix: one Import action per candidate, the only candidate is preferred", async () => {
            const { doc, first } = await withLines(typed);
            const uuid = await importsAt(doc, rangeOf(doc, first, "UUID"));
            assert.deepStrictEqual(uuid.map(a => a.title), ["Import java.util.UUID"]);
            assert.strictEqual(uuid[0].isPreferred, true);
            const date = await importsAt(doc, rangeOf(doc, first + 1, "Date"));
            assert.deepStrictEqual(date.map(a => a.title).sort(), ["Import java.sql.Date", "Import java.util.Date"]);
            assert.ok(date.every(a => !a.isPreferred), "several candidates: the user chooses");
            const call = await importsAt(doc, rangeOf(doc, first + 2, "runBlocking"));
            assert.deepStrictEqual(call.map(a => a.title), ["Import kotlinx.coroutines.runBlocking"]);
            const extension = await importsAt(doc, rangeOf(doc, first + 2, "itemCount"));
            assert.deepStrictEqual(extension.map(a => a.title), ["Import com.example.demo.domain.itemCount"]);
            // names that are fine: imported classes, locals, members, strings and comments
            for (const [line, word] of [[first, "randomUUID"], [first + 2, "order"], [first + 3, "UUID"], [first + 3, "Date"]] as Array<[number, string]>) {
                assert.deepStrictEqual((await importsAt(doc, rangeOf(doc, line, word))).map(a => a.title), [], word);
            }
        });

        test("the quick fix puts the import in its sorted place", async () => {
            const { doc, first } = await withLines(typed);
            const [action] = await importsAt(doc, rangeOf(doc, first, "UUID"));
            await vscode.workspace.applyEdit(action.edit!);
            const lines = doc.getText().split("\n");
            assert.strictEqual(lines[lines.indexOf("import java.math.BigDecimal") + 1], "import java.util.UUID");
            assert.deepStrictEqual(await importsAt(doc, rangeOf(doc, first + 1, "UUID")), [], "imported now");
        });

        test("each name that needs an import is marked in the editor", async () => {
            const { doc } = await withLines(typed);
            let marked: string[] = [];
            for (let i = 0; i < 40 && marked.length < 4; i++) {
                await new Promise(resolve => setTimeout(resolve, 250));
                marked = vscode.languages.getDiagnostics(doc.uri).filter(d => d.code === "missing-import").map(d => doc.getText(d.range)).sort();
            }
            assert.deepStrictEqual(marked, ["Date", "UUID", "itemCount", "runBlocking"]);
        });

        test("Add Missing Imports adds every import that has one candidate", async () => {
            const { doc } = await withLines(typed.filter(l => !l.includes("Date()")));
            await vscode.commands.executeCommand("kotlinDebugger.importMissing");
            const imports = doc.getText().split("\n").filter(l => l.startsWith("import "));
            const sample = (statement: string) => imports.indexOf(statement);
            assert.ok(sample("import java.util.UUID") > sample("import java.math.BigDecimal"), imports.join("\n"));
            assert.strictEqual(sample("import com.example.demo.domain.itemCount"), sample("import com.example.demo.domain.OrderRequest") + 1);
            assert.strictEqual(sample("import kotlinx.coroutines.runBlocking"), sample("import com.example.demo.service.OrderService") + 1);
        });

        test("source.addMissingImports (usable on save) skips names with several candidates", async () => {
            const { doc } = await withLines(typed);
            const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                "vscode.executeCodeActionProvider", doc.uri, new vscode.Range(0, 0, 0, 0), "source.addMissingImports");
            const action = actions.find(a => a.title === "Add missing imports");
            assert.ok(action?.edit, actions.map(a => a.title).join(", "));
            await vscode.workspace.applyEdit(action.edit);
            const text = doc.getText();
            assert.ok(text.includes("import java.util.UUID\n") && text.includes("import kotlinx.coroutines.runBlocking\n"), "unambiguous imports");
            assert.ok(!/^import java\.(util|sql)\.Date$/m.test(text), "Date has two candidates");
        });

        test("addUnambiguousOnTheFly: the import appears once the cursor has left the line; a removed import stays removed", async () => {
            const setting = vscode.workspace.getConfiguration("kotlinDebugger");
            await setting.update("imports.addUnambiguousOnTheFly", true, vscode.ConfigurationTarget.Global);
            try {
                const { doc, editor, first } = await withLines(typed);
                const hasImport = (statement: string) => doc.getText().split("\n").includes(statement);
                const settle = async (done: () => boolean) => {
                    for (let i = 0; i < 40 && !done(); i++) { await new Promise(resolve => setTimeout(resolve, 250)); }
                };
                // the cursor stays on the UUID line: runBlocking and itemCount are imported, UUID waits
                editor.selection = new vscode.Selection(first, 8, first, 8);
                await settle(() => hasImport("import kotlinx.coroutines.runBlocking"));
                assert.ok(hasImport("import kotlinx.coroutines.runBlocking") && hasImport("import com.example.demo.domain.itemCount"));
                assert.ok(!hasImport("import java.util.UUID"), "the line being edited is left alone");
                const last = doc.lineCount - 1;
                editor.selection = new vscode.Selection(last, 0, last, 0);
                await settle(() => hasImport("import java.util.UUID"));
                assert.ok(hasImport("import java.util.UUID"));
                assert.ok(!doc.getText().includes("import java.util.Date") && !doc.getText().includes("import java.sql.Date"), "two candidates: never automatic");
                // the user takes the UUID import out again (an undo, or deleting the line): it is not added a second time
                const line = doc.getText().split("\n").indexOf("import java.util.UUID");
                await editor.edit(e => e.delete(new vscode.Range(line, 0, line + 1, 0)));
                assert.ok(!hasImport("import java.util.UUID"), "removed");
                editor.selection = new vscode.Selection(last - 1, 0, last - 1, 0);
                await new Promise(resolve => setTimeout(resolve, 1500));
                assert.ok(!hasImport("import java.util.UUID"), "a removed import stays removed");
            } finally {
                await setting.update("imports.addUnambiguousOnTheFly", undefined, vscode.ConfigurationTarget.Global);
            }
        });

        test("code that compiles has nothing to import", async () => {
            const files = await vscode.workspace.findFiles("src/**/*.kt");
            assert.ok(files.length >= 8, `${files.length} Kotlin files`);
            for (const file of files) {
                const doc = await vscode.workspace.openTextDocument(file);
                const all = new vscode.Range(0, 0, doc.lineCount, 0);
                assert.deepStrictEqual((await importsAt(doc, all)).map(a => a.title), [], path.basename(file.fsPath));
            }
        });
    });

    test("package path lists subpackages and classes", async () => {
        const spring = names(await complete(controller, "import org.springframework."));
        assert.ok(spring.has("web") && spring.has("http") && spring.has("boot"), [...spring].join(", "));
        const concurrent = names(await complete(controller, "import java.util.concurrent."));
        assert.ok(concurrent.has("ConcurrentHashMap") && concurrent.has("atomic"));
    });
});
