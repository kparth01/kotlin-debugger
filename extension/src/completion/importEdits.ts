import * as path from "path";
import * as vscode from "vscode";
import { ASCII_LAYOUT, editorConfigLayout, ImportInsertion, ImportPlanner, INTELLIJ_LAYOUT } from "./imports";

/** Import order for a document: `ij_kotlin_imports_layout` of its `.editorconfig`, else `kotlinDebugger.imports.layout`. */
export function importLayout(doc: vscode.TextDocument): string {
    const configured = doc.uri.scheme === "file" ? editorConfigLayout(path.dirname(doc.uri.fsPath)) : undefined;
    if (configured) { return configured; }
    const setting = vscode.workspace.getConfiguration("kotlinDebugger", doc.uri).get<string>("imports.layout", "intellij");
    return setting === "ascii" ? ASCII_LAYOUT : INTELLIJ_LAYOUT;
}

export function importPlanner(doc: vscode.TextDocument, text: string = doc.getText()): ImportPlanner {
    return new ImportPlanner(text, importLayout(doc));
}

export function importTextEdit(insertion: ImportInsertion): vscode.TextEdit {
    return vscode.TextEdit.insert(new vscode.Position(insertion.line, insertion.character), insertion.newText);
}
