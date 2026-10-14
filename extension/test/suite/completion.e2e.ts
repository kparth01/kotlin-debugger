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

    test("package path lists subpackages and classes", async () => {
        const spring = names(await complete(controller, "import org.springframework."));
        assert.ok(spring.has("web") && spring.has("http") && spring.has("boot"), [...spring].join(", "));
        const concurrent = names(await complete(controller, "import java.util.concurrent."));
        assert.ok(concurrent.has("ConcurrentHashMap") && concurrent.has("atomic"));
    });
});
