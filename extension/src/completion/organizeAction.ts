import * as vscode from "vscode";
import { importLayout } from "./importEdits";
import { organizeImports } from "./organizeImports";

/** The edit that organizes the imports of `doc`; `undefined` when they are in order already. */
function organizeEdit(doc: vscode.TextDocument): vscode.TextEdit | undefined {
    const organized = organizeImports(doc.getText(), importLayout(doc));
    if (!organized) { return undefined; }
    // every import was unused: the block goes, with its line break
    const end = organized.newText ? doc.lineAt(organized.endLine).range.end : new vscode.Position(organized.endLine + 1, 0);
    return vscode.TextEdit.replace(new vscode.Range(new vscode.Position(organized.startLine, 0), end), organized.newText);
}

/**
 * **Kotlin: Organize Imports** (sort by the import layout, drop duplicates and unused imports). It is also offered as
 * the `source.organizeImports` code action (Shift+Alt+O, on save) unless `kotlinDebugger.imports.organize` is
 * `never`, or `auto` and the Kotlin Jump extension, which has its own Organize Imports, is installed.
 */
export function registerOrganizeImports(context: vscode.ExtensionContext, selector: vscode.DocumentSelector): void {
    const asSourceAction = () => {
        const mode = vscode.workspace.getConfiguration("kotlinDebugger").get<string>("imports.organize", "auto");
        return mode === "always" || (mode === "auto" && !vscode.extensions.getExtension("elumine.kotlin-jump"));
    };
    const provider: vscode.CodeActionProvider = {
        provideCodeActions(doc, _range, context) {
            if (!context.only || !context.only.contains(vscode.CodeActionKind.SourceOrganizeImports) || !asSourceAction()) { return undefined; }
            const edit = organizeEdit(doc);
            if (!edit) { return undefined; }
            const action = new vscode.CodeAction("Organize Imports", vscode.CodeActionKind.SourceOrganizeImports);
            action.edit = new vscode.WorkspaceEdit();
            action.edit.set(doc.uri, [edit]);
            return [action];
        },
    };
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(selector, provider, { providedCodeActionKinds: [vscode.CodeActionKind.SourceOrganizeImports] }),
        vscode.commands.registerCommand("kotlinDebugger.organizeImports", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== "kotlin") { return; }
            const edit = organizeEdit(editor.document);
            if (!edit) {
                vscode.window.setStatusBarMessage("Kotlin: imports are already organized", 4000);
                return;
            }
            const change = new vscode.WorkspaceEdit();
            change.set(editor.document.uri, [edit]);
            await vscode.workspace.applyEdit(change);
        }),
    );
}
