import * as vscode from "vscode";
import { ClassIndex, FileContext } from "./classIndex";
import { importLayout, importPlanner, importTextEdit } from "./importEdits";
import { withImports } from "./imports";
import { MissingImport, missingImports } from "./missingImports";
import { TypeSystem } from "./typeSystem";

/** What the completion provider knows about the current text of a document. */
export interface Analysis {
    index: ClassIndex;
    types: TypeSystem;
    file: FileContext;
    text: string;
}

export interface Analyzer {
    analyze(doc: vscode.TextDocument): Promise<Analysis | undefined>;
}

/** `source.addMissingImports`: usable in `editor.codeActionsOnSave`; adds the imports that have one candidate. */
const ADD_MISSING = vscode.CodeActionKind.Source.append("addMissingImports");
const DIAGNOSTIC_CODE = "missing-import";
const REFRESH_DELAY_MS = 300;

/**
 * Imports for code that was typed or pasted without a completion: a diagnostic on each name that needs an import,
 * an "Import …" quick fix per candidate, the "Add Missing Imports" command, and (opt-in) imports added on the fly.
 */
export function registerImportActions(
    context: vscode.ExtensionContext, selector: vscode.DocumentSelector, analyzer: Analyzer, output: vscode.OutputChannel,
): { refreshAll(): void } {
    const actions = new ImportActions(analyzer, output);
    let selectionTimer: NodeJS.Timeout | undefined;
    context.subscriptions.push(
        actions,
        vscode.languages.registerCodeActionsProvider(selector, actions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, ADD_MISSING] }),
        vscode.commands.registerCommand("kotlinDebugger.importMissing", () => actions.addMissingImports()),
        vscode.workspace.onDidOpenTextDocument(doc => actions.schedule(doc)),
        vscode.workspace.onDidChangeTextDocument(e => actions.schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => actions.forget(doc)),
        vscode.window.onDidChangeTextEditorSelection(e => {
            clearTimeout(selectionTimer);
            selectionTimer = setTimeout(() => actions.importOnTheFly(e.textEditor.document).catch(() => undefined), 200);
        }),
        { dispose: () => clearTimeout(selectionTimer) },
    );
    vscode.workspace.textDocuments.forEach(doc => actions.schedule(doc));
    return actions;
}

function isKotlin(doc: vscode.TextDocument): boolean {
    return doc.languageId === "kotlin" && (doc.uri.scheme === "file" || doc.uri.scheme === "untitled");
}

function settings(doc: vscode.TextDocument): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("kotlinDebugger", doc.uri);
}

function severity(doc: vscode.TextDocument): vscode.DiagnosticSeverity | undefined {
    switch (settings(doc).get<string>("imports.highlightMissing", "hint")) {
        case "off": return undefined;
        case "warning": return vscode.DiagnosticSeverity.Warning;
        case "information": return vscode.DiagnosticSeverity.Information;
        default: return vscode.DiagnosticSeverity.Hint;
    }
}

/** One edit that turns the document into `newText`, touching only the part that differs. */
function minimalEdit(doc: vscode.TextDocument, newText: string): vscode.TextEdit {
    const old = doc.getText();
    let prefix = 0;
    while (prefix < old.length && prefix < newText.length && old[prefix] === newText[prefix]) { prefix++; }
    let suffix = 0;
    while (suffix < old.length - prefix && suffix < newText.length - prefix
        && old[old.length - 1 - suffix] === newText[newText.length - 1 - suffix]) { suffix++; }
    return vscode.TextEdit.replace(
        new vscode.Range(doc.positionAt(prefix), doc.positionAt(old.length - suffix)), newText.slice(prefix, newText.length - suffix));
}

/** The occurrences of each missing name, in document order. */
function byName(missing: MissingImport[]): Map<string, MissingImport[]> {
    const names = new Map<string, MissingImport[]>();
    for (const m of missing) {
        const same = names.get(m.name);
        if (same) { same.push(m); } else { names.set(m.name, [m]); }
    }
    return names;
}

class ImportActions implements vscode.CodeActionProvider, vscode.Disposable {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection("kotlin-imports");
    private readonly results = new Map<string, { version: number; missing: MissingImport[] }>();
    private readonly timers = new Map<string, NodeJS.Timeout>();
    /** Per document: imports that were added on the fly once (an undo is not fought). */
    private readonly autoImported = new Map<string, Set<string>>();

    constructor(private readonly analyzer: Analyzer, private readonly output: vscode.OutputChannel) {}

    dispose(): void {
        this.timers.forEach(t => clearTimeout(t));
        this.diagnostics.dispose();
    }

    /** The class index or other source files changed: every open Kotlin file is checked again. */
    refreshAll(): void {
        this.results.clear();
        vscode.workspace.textDocuments.forEach(doc => this.schedule(doc, 1000));
    }

    schedule(doc: vscode.TextDocument, delay = REFRESH_DELAY_MS): void {
        if (!isKotlin(doc)) { return; }
        const key = doc.uri.toString();
        clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            this.refresh(doc).catch(e => this.output.appendLine(`[imports] ${(e as Error).stack ?? e}`));
        }, delay));
    }

    forget(doc: vscode.TextDocument): void {
        const key = doc.uri.toString();
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
        this.results.delete(key);
        this.autoImported.delete(key);
        this.diagnostics.delete(doc.uri);
    }

    private async refresh(doc: vscode.TextDocument): Promise<void> {
        if (doc.isClosed) { return; }
        const missing = await this.scan(doc);
        // `undefined`: completion is off, or the text changed while indexing (a newer refresh is scheduled).
        if (!missing) {
            if (!this.timers.has(doc.uri.toString())) { this.diagnostics.delete(doc.uri); }
            return;
        }
        const level = severity(doc);
        this.diagnostics.set(doc.uri, level === undefined ? [] : missing.map(m => {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end)), `'${m.name}' is not imported`, level);
            diagnostic.source = "Kotlin";
            diagnostic.code = DIAGNOSTIC_CODE;
            return diagnostic;
        }));
        await this.importOnTheFly(doc);
    }

    /** Names that need an import in the current text of `doc`. */
    private async scan(doc: vscode.TextDocument): Promise<MissingImport[] | undefined> {
        const key = doc.uri.toString();
        const version = doc.version;
        const cached = this.results.get(key);
        if (cached?.version === version) { return cached.missing; }
        const analysis = await this.analyzer.analyze(doc);
        if (!analysis || doc.version !== version) { return undefined; }
        let missing: MissingImport[] = [];
        try {
            missing = missingImports(analysis.text, analysis.file, analysis.types, analysis.index);
        } catch (e) {
            this.output.appendLine(`[imports] Finding missing imports failed: ${(e as Error).stack ?? e}`);
        }
        this.results.set(key, { version, missing });
        return missing;
    }

    async provideCodeActions(
        doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext,
    ): Promise<vscode.CodeAction[] | undefined> {
        const wantFixes = !context.only || context.only.contains(vscode.CodeActionKind.QuickFix);
        const wantSource = !!context.only && context.only.contains(ADD_MISSING);
        if (!wantFixes && !wantSource) { return undefined; }
        const missing = await this.scan(doc);
        if (!missing?.length) { return undefined; }
        const actions: vscode.CodeAction[] = [];
        if (wantFixes) {
            const from = doc.offsetAt(range.start);
            const to = doc.offsetAt(range.end);
            const planner = importPlanner(doc);
            const offered = new Set<string>();
            for (const m of missing) {
                if (m.start > to || m.end < from) { continue; }
                const where = new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end));
                for (const candidate of m.candidates) {
                    const insertion = planner.plan(candidate);
                    if (!insertion || offered.has(candidate)) { continue; }
                    offered.add(candidate);
                    const action = new vscode.CodeAction(`Import ${candidate}`, vscode.CodeActionKind.QuickFix);
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.set(doc.uri, [importTextEdit(insertion)]);
                    action.diagnostics = context.diagnostics.filter(d => d.code === DIAGNOSTIC_CODE && !!d.range.intersection(where));
                    action.isPreferred = m.candidates.length === 1;
                    actions.push(action);
                }
            }
        }
        if (wantSource) {
            const names = [...byName(missing).values()].filter(o => o[0].candidates.length === 1).map(o => o[0].candidates[0]);
            if (names.length) {
                const action = new vscode.CodeAction("Add missing imports", ADD_MISSING);
                action.edit = new vscode.WorkspaceEdit();
                action.edit.set(doc.uri, [minimalEdit(doc, withImports(doc.getText(), names, importLayout(doc)))]);
                actions.push(action);
            }
        }
        return actions;
    }

    /** "Kotlin: Add Missing Imports": adds every import with one candidate and asks for the others. */
    async addMissingImports(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isKotlin(editor.document)) { return; }
        const doc = editor.document;
        const missing = await this.scan(doc);
        if (!missing?.length) {
            vscode.window.setStatusBarMessage("Kotlin: no missing imports found", 4000);
            return;
        }
        const chosen: string[] = [];
        for (const [name, occurrences] of byName(missing)) {
            const candidates = occurrences[0].candidates;
            if (candidates.length === 1) {
                chosen.push(candidates[0]);
                continue;
            }
            editor.revealRange(new vscode.Range(doc.positionAt(occurrences[0].start), doc.positionAt(occurrences[0].end)));
            const pick = await vscode.window.showQuickPick(
                candidates.map(c => ({ label: c.slice(c.lastIndexOf(".") + 1), description: c.slice(0, c.lastIndexOf(".")), candidate: c })),
                { placeHolder: `Import for '${name}' (Escape skips it)` });
            if (pick) { chosen.push(pick.candidate); }
        }
        if (!chosen.length) { return; }
        const edit = new vscode.WorkspaceEdit();
        edit.set(doc.uri, [minimalEdit(doc, withImports(doc.getText(), chosen, importLayout(doc)))]);
        await vscode.workspace.applyEdit(edit);
        vscode.window.setStatusBarMessage(`Kotlin: added ${chosen.length} import${chosen.length === 1 ? "" : "s"}`, 4000);
    }

    /**
     * `kotlinDebugger.imports.addUnambiguousOnTheFly`: a name with exactly one candidate is imported once the cursor
     * has left its line. Each import is added at most once per document, so undoing it sticks.
     */
    async importOnTheFly(doc: vscode.TextDocument): Promise<void> {
        if (!isKotlin(doc) || !settings(doc).get<boolean>("imports.addUnambiguousOnTheFly", false)) { return; }
        const editor = vscode.window.activeTextEditor;
        const key = doc.uri.toString();
        const cached = this.results.get(key);
        if (!editor || editor.document !== doc || !cached || cached.version !== doc.version) { return; }
        const cursorLine = editor.selection.active.line;
        const attempted = this.autoImported.get(key) ?? new Set<string>();
        const names: string[] = [];
        for (const occurrences of byName(cached.missing).values()) {
            const candidates = occurrences[0].candidates;
            if (candidates.length !== 1 || attempted.has(candidates[0])) { continue; }
            if (occurrences.some(o => doc.positionAt(o.start).line === cursorLine)) { continue; }
            names.push(candidates[0]);
        }
        if (!names.length) { return; }
        names.forEach(n => attempted.add(n));
        this.autoImported.set(key, attempted);
        const edit = new vscode.WorkspaceEdit();
        edit.set(doc.uri, [minimalEdit(doc, withImports(doc.getText(), names, importLayout(doc)))]);
        await vscode.workspace.applyEdit(edit);
    }
}
