import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ClassSource, DirSource, JarSource, JImageSource } from "./archives";
import { ClassIndex, Entry, EntryKind, parseFileContext, qualifierAt } from "./classIndex";
import { findBuildRoot, findJdkClasses, ProjectClasspath, resolveClasspath } from "./classpath";
import { Inference, memberEntries, staticEntries, Value } from "./inference";
import { kotlinSourceFiles, ProjectSources, readSource } from "./sources";
import { TypeSystem } from "./typeSystem";
import { binaryToClassId, classIdToBinary, renderType } from "./types";

const KINDS: Record<EntryKind, vscode.CompletionItemKind> = {
    package: vscode.CompletionItemKind.Module,
    class: vscode.CompletionItemKind.Class,
    interface: vscode.CompletionItemKind.Interface,
    enum: vscode.CompletionItemKind.Enum,
    annotation: vscode.CompletionItemKind.Interface,
    method: vscode.CompletionItemKind.Method,
    property: vscode.CompletionItemKind.Property,
    field: vscode.CompletionItemKind.Field,
    constant: vscode.CompletionItemKind.Constant,
    enumConstant: vscode.CompletionItemKind.EnumMember,
    variable: vscode.CompletionItemKind.Variable,
    keyword: vscode.CompletionItemKind.Keyword,
    namedArgument: vscode.CompletionItemKind.Property,
};

/** Packages whose classes are not offered for auto-import. */
const INTERNAL_PACKAGE = /(?:^|\/)(?:internal|impl)(?:\/|$)|^(?:sun|jdk|com\/sun)\//;

const HARD_KEYWORDS = new Set([
    "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null",
    "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val", "var", "when", "while",
]);

export function registerCompletion(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
    const provider = new ClassMemberCompletionProvider(output);
    let timer: NodeJS.Timeout | undefined;
    const invalidate = () => {
        clearTimeout(timer);
        timer = setTimeout(() => provider.invalidate(), 2000);
    };
    const watchers = [
        vscode.workspace.createFileSystemWatcher("**/{pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,libs.versions.toml}"),
        vscode.workspace.createFileSystemWatcher("**/*.class"),
    ];
    for (const w of watchers) {
        w.onDidCreate(invalidate);
        w.onDidChange(invalidate);
        w.onDidDelete(invalidate);
    }
    const sources = vscode.workspace.createFileSystemWatcher("**/*.kt");
    sources.onDidCreate(uri => provider.sourceChanged(uri));
    sources.onDidChange(uri => provider.sourceChanged(uri));
    sources.onDidDelete(uri => provider.sourceChanged(uri, true));
    watchers.push(sources);
    const kotlinFiles: vscode.DocumentSelector = [
        { language: "kotlin", scheme: "file" },
        { language: "kotlin", scheme: "untitled" },
    ];
    context.subscriptions.push(
        ...watchers,
        { dispose: () => clearTimeout(timer) },
        vscode.languages.registerCompletionItemProvider(kotlinFiles, provider, "."),
        vscode.languages.registerSignatureHelpProvider(kotlinFiles, provider, { triggerCharacters: ["(", ","], retriggerCharacters: [","] }),
        vscode.workspace.onDidOpenTextDocument(doc => provider.warmUp(doc)),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("kotlinDebugger")) { provider.invalidate(); }
        }),
    );
    vscode.workspace.textDocuments.forEach(doc => provider.warmUp(doc));
}

function enabled(): boolean {
    return vscode.workspace.getConfiguration("kotlinDebugger").get<boolean>("completion.enabled", true);
}

/**
 * `value.` → members and extensions of the value's inferred type; `ClassName.` → static members (and Kotlin
 * object/companion members); `a.b.` → packages and classes.
 */
class ClassMemberCompletionProvider implements vscode.CompletionItemProvider, vscode.SignatureHelpProvider {
    /** By build root: one index per Maven/Gradle module. */
    private readonly indexes = new Map<string, Promise<ClassIndex>>();
    /** Parsed jar/jimage directories, shared by all projects. */
    private readonly archives = new Map<string, { mtime: number; source: ClassSource }>();
    private readonly typeSystems = new WeakMap<ClassIndex, TypeSystem>();
    private readonly projectSources = new WeakMap<ClassIndex, ProjectSources>();

    constructor(private readonly output: vscode.OutputChannel) {}

    invalidate(): void { this.indexes.clear(); }

    /** A `.kt` file was saved, created or deleted outside the editor that is completing. */
    sourceChanged(uri: vscode.Uri, deleted = false): void {
        for (const [root, building] of this.indexes) {
            if (!root || !uri.fsPath.startsWith(root + path.sep)) { continue; }
            building.then(index => {
                const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
                const text = deleted ? undefined : open ? open.getText() : readSource(uri.fsPath);
                if (this.projectSources.get(index)?.set(uri.fsPath, text)) { this.typeSystems.get(index)?.invalidate(); }
            }, () => undefined);
        }
    }

    warmUp(doc: vscode.TextDocument): void {
        if (doc.languageId === "kotlin" && enabled()) { this.indexFor(doc.uri).catch(() => undefined); }
    }

    async provideCompletionItems(
        doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
        if (!enabled()) { return undefined; }
        const linePrefix = doc.lineAt(position.line).text.slice(0, position.character);
        const word = /\w*$/.exec(linePrefix)![0];
        const text = doc.getText();
        const dot = doc.offsetAt(position) - word.length - 1;
        if (text[dot] !== ".") { return this.scopeCompletion(doc, position, word, text, token); }
        let index: ClassIndex;
        try {
            index = await this.indexFor(doc.uri);
        } catch {
            return undefined;
        }
        if (token.isCancellationRequested) { return undefined; }
        const file = parseFileContext(text);
        const types = this.typeSystem(index);
        if (doc.uri.scheme === "file" && this.projectSources.get(index)?.set(doc.uri.fsPath, text)) { types.invalidate(); }
        let value: Value | undefined;
        try {
            const inference = new Inference(text, file, types, p => index.hasPackage(p));
            if (inference.inCommentOrString(dot)) { return undefined; }
            value = inference.receiver(dot);
            if (value?.kind === "value") {
                return memberEntries(value.type, types, file).map(e => this.item(e, index, doc));
            }
        } catch (e) {
            this.output.appendLine(`[completion] Type inference failed: ${(e as Error).stack ?? e}`);
        }
        const qualifier = qualifierAt(linePrefix);
        const entries = qualifier ? index.complete(qualifier, file) : [];
        if (!entries.length && value?.kind === "class") { entries.push(...staticEntries(value.id, types)); }
        return entries.map(e => this.item(e, index, doc));
    }

    /** Parameter hints for the call around the cursor: overloads, active parameter (named arguments too). */
    async provideSignatureHelp(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.SignatureHelp | undefined> {
        if (!enabled()) { return undefined; }
        let index: ClassIndex;
        try {
            index = await this.indexFor(doc.uri);
        } catch {
            return undefined;
        }
        if (token.isCancellationRequested) { return undefined; }
        const text = doc.getText();
        const offset = doc.offsetAt(position);
        const file = parseFileContext(text);
        const types = this.typeSystem(index);
        if (doc.uri.scheme === "file" && this.projectSources.get(index)?.set(doc.uri.fsPath, text)) { types.invalidate(); }
        let call: ReturnType<Inference["callAt"]>;
        try {
            const inference = new Inference(text, file, types, p => index.hasPackage(p));
            if (inference.inCommentOrString(Math.max(0, offset - 1))) { return undefined; }
            call = inference.callAt(offset);
        } catch (e) {
            this.output.appendLine(`[completion] Signature help failed: ${(e as Error).stack ?? e}`);
        }
        if (!call?.functions.length) { return undefined; }
        const help = new vscode.SignatureHelp();
        const functions = call.functions.slice(0, 30);
        help.signatures = functions.map(f => {
            const params = f.params.map(p => `${p.vararg ? "vararg " : ""}${p.name ? `${p.name}: ` : ""}${renderType(p.type)}${p.hasDefault ? " = …" : ""}`);
            const prefix = `${f.suspend ? "suspend " : ""}${f.name}(`;
            const signature = new vscode.SignatureInformation(`${prefix}${params.join(", ")}): ${renderType(f.returnType)}`);
            let at = prefix.length;
            signature.parameters = params.map(p => {
                const info = new vscode.ParameterInformation([at, at + p.length]);
                at += p.length + 2;
                return info;
            });
            const named = call!.named ? f.params.findIndex(p => p.name === call!.named) : -1;
            const vararg = f.params.findIndex(p => p.vararg);
            signature.activeParameter = named >= 0 ? named : vararg >= 0 && call!.argument >= vararg ? vararg : call!.argument;
            return signature;
        });
        const fits = functions.findIndex(f => f.params.length > call!.argument || f.params.some(p => p.vararg));
        help.activeSignature = Math.max(0, fits);
        help.activeParameter = help.signatures[help.activeSignature].activeParameter as number;
        return help;
    }

    /** No receiver: locals, `this` members, top-level declarations, classes (with auto-import), keywords. */
    private async scopeCompletion(
        doc: vscode.TextDocument, position: vscode.Position, word: string, text: string, token: vscode.CancellationToken,
    ): Promise<vscode.CompletionList | undefined> {
        const offset = doc.offsetAt(position);
        const before = text.slice(Math.max(0, offset - word.length - 60), offset - word.length);
        // a new name is being declared, or a package path / callable reference
        if (/(?:\b(?:val|var|fun|class|object|interface|typealias|package|import)\s+(?:<[^>]*>\s*)?|::|`)$/.test(before) || /\d$/.test(before)) { return undefined; }
        if (/^\d/.test(word)) { return undefined; }
        let index: ClassIndex;
        try {
            index = await this.indexFor(doc.uri);
        } catch {
            return undefined;
        }
        if (token.isCancellationRequested) { return undefined; }
        const file = parseFileContext(text);
        const types = this.typeSystem(index);
        if (doc.uri.scheme === "file" && this.projectSources.get(index)?.set(doc.uri.fsPath, text)) { types.invalidate(); }
        const entries: Entry[] = [];
        const annotation = before.endsWith("@");
        try {
            const inference = new Inference(text, file, types, p => index.hasPackage(p));
            if (inference.inCommentOrString(Math.max(0, offset - word.length - 1)) && inference.inCommentOrString(offset - 1)) { return undefined; }
            if (!annotation) { entries.push(...inference.scopeEntries(offset, word)); }
        } catch (e) {
            this.output.appendLine(`[completion] Scope completion failed: ${(e as Error).stack ?? e}`);
        }
        const first = word[0]?.toLowerCase();
        const accept = (simple: string) => !first || simple[0].toLowerCase() === first;
        const visible = new Set<string>();
        for (const id of types.visibleClasses(file, accept)) {
            const simple = id.slice(id.lastIndexOf("/") + 1);
            visible.add(simple);
            entries.push({ kind: "class", name: simple, owner: classIdToBinary(id), group: 3 });
        }
        if (word.length >= 1) {
            for (const binary of index.classesStartingWith(word, 150)) {
                const simple = binary.slice(binary.lastIndexOf("/") + 1);
                if (visible.has(simple) || INTERNAL_PACKAGE.test(binary) || !types.isUsableClass(binaryToClassId(binary))) { continue; }
                entries.push({ kind: "class", name: simple, owner: binary, importName: binary.replace(/\//g, ".").replace(/\$/g, "."), group: 4 });
            }
        }
        // Incomplete: VS Code asks again as the word grows, so the class list stays short and relevant.
        return new vscode.CompletionList(entries.map(e => this.item(e, index, doc)), true);
    }

    private typeSystem(index: ClassIndex): TypeSystem {
        let types = this.typeSystems.get(index);
        if (!types) {
            const sources = this.projectSources.get(index);
            types = new TypeSystem(index, sources);
            sources?.attach(types);
            this.typeSystems.set(index, types);
        }
        return types;
    }

    private indexFor(uri: vscode.Uri): Promise<ClassIndex> {
        const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
        const root = (uri.scheme === "file" ? findBuildRoot(path.dirname(uri.fsPath), folder ?? path.parse(uri.fsPath).root) : undefined) ?? folder;
        const key = root ?? "";
        let index = this.indexes.get(key);
        if (!index) {
            const building = this.build(root);
            index = building;
            this.indexes.set(key, building);
            building.catch(e => {
                this.output.appendLine(`[completion] Indexing ${root ?? "(no folder)"} failed: ${(e as Error).message}`);
                if (this.indexes.get(key) === building) { this.indexes.delete(key); }
            });
        }
        return index;
    }

    private async build(root: string | undefined): Promise<ClassIndex> {
        const yieldToHost = () => new Promise(resolve => setImmediate(resolve));
        await yieldToHost();
        const started = Date.now();
        const config = vscode.workspace.getConfiguration("kotlinDebugger");
        const jdk = findJdkClasses(config.get<string>("javaHome") || undefined);
        const project: ProjectClasspath = root ? resolveClasspath(root) : { buildTool: "none", entries: [], missing: [] };
        const extra = config.get<string[]>("completion.classpath", []).flatMap(p => expand(path.resolve(root ?? "", p)));
        const sources: ClassSource[] = [];
        for (const location of [...(jdk ? [jdk] : []), ...project.entries, ...extra]) {
            await yieldToHost();
            const source = this.source(location);
            if (source) { sources.push(source); }
        }
        const index = new ClassIndex(sources);
        // Kotlin sources: declarations that are not compiled yet (editor text wins over the file on disk).
        const projectSources = new ProjectSources(p => index.hasPackage(p));
        const files = root ? kotlinSourceFiles(root) : [];
        for (const f of files) {
            const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f);
            const text = open ? open.getText() : readSource(f);
            if (text !== undefined) { projectSources.set(f, text); }
        }
        this.projectSources.set(index, projectSources);
        this.output.appendLine(
            `[completion] ${root ?? "(no folder)"}: ${index.size} classes from ${sources.length} classpath entries ` +
            `and ${files.length} Kotlin source files (${project.buildTool}; JDK: ${jdk ?? "not found, set kotlinDebugger.javaHome"}) in ${Date.now() - started} ms`);
        if (project.missing.length) {
            this.output.appendLine(`[completion] Not in the local repository (build the project once to download): ${project.missing.join(", ")}`);
        }
        // Kotlin declarations (built-ins, extension functions) are read on first use; do it before the first `.`.
        setImmediate(() => {
            const t = Date.now();
            const count = this.typeSystem(index).warmUp();
            this.output.appendLine(`[completion] ${count} Kotlin top-level declarations and extensions indexed in ${Date.now() - t} ms`);
        });
        return index;
    }

    private source(location: string): ClassSource | undefined {
        try {
            const stat = fs.statSync(location);
            if (stat.isDirectory()) { return new DirSource(location); }
            const cached = this.archives.get(location);
            if (cached?.mtime === stat.mtimeMs) { return cached.source; }
            const source = path.basename(location) === "modules" ? new JImageSource(location) : new JarSource(location);
            this.archives.set(location, { mtime: stat.mtimeMs, source });
            return source;
        } catch (e) {
            this.output.appendLine(`[completion] Skipped ${location}: ${(e as Error).message}`);
            return undefined;
        }
    }

    private item(e: Entry, index: ClassIndex, doc: vscode.TextDocument): vscode.CompletionItem {
        const label: vscode.CompletionItemLabel = { label: e.name };
        const item = new vscode.CompletionItem(label, KINDS[e.kind]);
        const name = HARD_KEYWORDS.has(e.name) ? `\`${e.name}\`` : e.name;
        const importPackage = e.importName?.slice(0, e.importName.lastIndexOf("."));
        if (e.kind === "method") {
            const params = e.params ?? [];
            label.detail = `(${params.map((p, i) => param(p, !!e.vararg && i === params.length - 1)).join(", ")})`;
            item.insertText = callSnippet(name, params, !!e.lambda);
        } else if (e.kind === "namedArgument") {
            label.label = `${e.name} =`;
            item.insertText = `${name} = `;
            item.filterText = e.name;
        } else {
            item.insertText = name;
        }
        label.description = [e.type, importPackage].filter(Boolean).join(" · ") || undefined;
        if (e.kind !== "package" && e.kind !== "keyword") {
            const owner = e.owner?.replace(/\//g, ".").replace(/\$/g, ".");
            const location = e.owner ? index.locationOf(e.owner) : undefined;
            const from = location ? (/^(modules|rt\.jar)$/.test(path.basename(location)) ? "JDK" : path.basename(location))
                : e.owner?.startsWith("kotlin/") ? "Kotlin built-in" : undefined;
            const docs = new vscode.MarkdownString().appendCodeblock(declaration(e), "kotlin");
            docs.appendMarkdown(e.pkg ? `${e.receiver ? "extension " : ""}from \`${e.pkg}\`` : e.kind === "variable" || e.kind === "namedArgument" ? "" : [owner && `\`${owner}\``, from].filter(Boolean).join(" — "));
            if (e.importName) { docs.appendMarkdown(`\n\nAdds \`import ${e.importName}\``); }
            item.documentation = docs;
        }
        if (e.deprecated) { item.tags = [vscode.CompletionItemTag.Deprecated]; }
        // Members first, then nested classes, then inherited members.
        const nestedClass = ["class", "interface", "enum", "annotation"].includes(e.kind) && !!e.owner?.includes("$");
        item.sortText = `${e.group ?? (e.inherited ? 2 : nestedClass ? 1 : 0)}${e.name}`;
        if (e.importName) { item.additionalTextEdits = [importEdit(doc, e.importName)]; }
        return item;
    }
}

/** A classpath setting entry; `dir/*` means every jar in `dir`, as on a Java classpath. */
function expand(location: string): string[] {
    if (path.basename(location) !== "*") { return [location]; }
    const dir = path.dirname(location);
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith(".jar")).map(f => path.join(dir, f));
    } catch {
        return [];
    }
}

type ParamText = { name?: string; type: string; hasDefault?: boolean };

function param(p: ParamText, vararg: boolean): string {
    const type = vararg ? p.type.replace(/^Array<(?:out )?(.*)>$/, "$1").replace(/^(\w+)Array$/, "$1") : p.type;
    return `${vararg ? "vararg " : ""}${p.name ? `${p.name}: ` : ""}${type}${p.hasDefault ? " = …" : ""}`;
}

/** `name(${1:a}, ${2:b})`; optional parameters are left out; a trailing lambda becomes `name { }`. */
function callSnippet(name: string, params: ParamText[], trailingLambda: boolean): vscode.SnippetString {
    const snippet = new vscode.SnippetString().appendText(name);
    const required = params.filter((p, i) => !p.hasDefault && !(trailingLambda && i === params.length - 1));
    if (required.length || !trailingLambda) {
        snippet.appendText("(");
        required.forEach((p, i) => {
            if (i) { snippet.appendText(", "); }
            snippet.appendPlaceholder(p.name ?? p.type);
        });
        if (!required.length && params.length) { snippet.appendTabstop(0); }
        snippet.appendText(")");
    }
    if (trailingLambda) {
        snippet.appendText(" { ");
        snippet.appendTabstop(0);
        snippet.appendText(" }");
    }
    return snippet;
}

function declaration(e: Entry): string {
    switch (e.kind) {
        case "method": {
            const params = (e.params ?? []).map((p, i, all) => param(p, !!e.vararg && i === all.length - 1));
            const typeParams = e.typeParams?.length ? `<${e.typeParams.join(", ")}> ` : "";
            const receiver = e.receiver ? `${e.receiver}.` : "";
            return `${e.suspend ? "suspend " : ""}fun ${typeParams}${receiver}${e.name}(${params.join(", ")}): ${e.type}`;
        }
        case "property": return `${e.isVar ? "var" : "val"} ${e.receiver ? `${e.receiver}.` : ""}${e.name}: ${e.type}${e.value ? ` = ${e.value}` : ""}`;
        case "constant": return `val ${e.name}: ${e.type}${e.value ? ` = ${e.value}` : ""}`;
        case "variable": return `${e.isVar ? "var" : "val"} ${e.name}${e.type ? `: ${e.type}` : ""}`;
        case "namedArgument": return `${e.name}: ${e.type}`;
        case "field": return `var ${e.name}: ${e.type}`;
        case "enumConstant": return `${e.type}.${e.name}`;
        case "enum": return `enum class ${e.name}`;
        case "annotation": return `annotation class ${e.name}`;
        case "interface": return `interface ${e.name}`;
        default: return `class ${e.name}`;
    }
}

/** Inserts `import <name>` after the last import, or after the package directive. */
function importEdit(doc: vscode.TextDocument, name: string): vscode.TextEdit {
    let lastImport = -1;
    let packageLine = -1;
    for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        if (/^\s*import\s/.test(text)) { lastImport = i; }
        else if (packageLine < 0 && /^\s*package\s/.test(text)) { packageLine = i; }
    }
    if (lastImport >= 0) { return vscode.TextEdit.insert(new vscode.Position(lastImport + 1, 0), `import ${name}\n`); }
    if (packageLine >= 0) { return vscode.TextEdit.insert(new vscode.Position(packageLine + 1, 0), `\nimport ${name}\n`); }
    return vscode.TextEdit.insert(new vscode.Position(0, 0), `import ${name}\n\n`);
}
