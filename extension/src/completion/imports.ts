import * as fs from "fs";
import * as path from "path";

/** IntelliJ's default order: everything else, `java`, `javax`, `kotlin`, then alias imports. */
export const INTELLIJ_LAYOUT = "*,java.**,javax.**,kotlin.**,^";
/** One block in ASCII order (the `android_studio` code style of ktlint). */
export const ASCII_LAYOUT = "*";

/** Packages every Kotlin/JVM file sees without an import. */
export const DEFAULT_IMPORT_PACKAGES = [
    "kotlin", "kotlin.annotation", "kotlin.collections", "kotlin.comparisons", "kotlin.io",
    "kotlin.ranges", "kotlin.sequences", "kotlin.text", "kotlin.jvm", "java.lang",
];

export interface HeaderImport {
    /** Dotted name without backticks and without the trailing `.*`. */
    name: string;
    alias?: string;
    star: boolean;
    line: number;
}

/** The part of a Kotlin file before its first declaration. */
export interface Header {
    packageName: string;
    /** Line of the `package` directive, or -1. */
    packageLine: number;
    /** Last line of the shebang and `@file:` annotations, or -1. */
    preambleLine: number;
    imports: HeaderImport[];
    /** First line of the first declaration, including a comment attached to it (the line count when there is none). */
    bodyLine: number;
}

const IMPORT = /^\s*import\s+([\w.`]+?)(\.\*)?(?:\s+as\s+(`[^`]+`|\w+))?\s*;?\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/;
const PACKAGE = /^\s*package\s+([\w.`]+)/;

/** Reads the header only, so an `import` inside a string or comment further down is never taken for one. */
export function parseHeader(text: string): Header {
    const lines = text.split("\n");
    const header: Header = { packageName: "", packageLine: -1, preambleLine: -1, imports: [], bodyLine: lines.length };
    let inComment = false;
    let annotationDepth = 0;
    /** Start of the comment lines directly above the current line, or -1 after a blank or header line. */
    let comment = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, "");
        const trimmed = line.trim();
        if (inComment) {
            if (line.includes("*/")) { inComment = false; }
            continue;
        }
        if (annotationDepth > 0) {
            annotationDepth += depthChange(line);
            header.preambleLine = i;
            continue;
        }
        if (!trimmed) { comment = -1; continue; }
        if (trimmed.startsWith("//") || trimmed.startsWith("/*")) {
            if (comment < 0) { comment = i; }
            inComment = trimmed.startsWith("/*") && !trimmed.includes("*/");
            continue;
        }
        if (i === 0 && trimmed.startsWith("#!")) {
            header.preambleLine = i;
        } else if (trimmed.startsWith("@file:")) {
            header.preambleLine = i;
            annotationDepth = Math.max(0, depthChange(line));
        } else {
            const pkg = header.packageLine < 0 && !header.imports.length ? PACKAGE.exec(line) : null;
            const imp = pkg ? null : IMPORT.exec(line);
            if (pkg) {
                header.packageName = pkg[1].replace(/`/g, "");
                header.packageLine = i;
            } else if (imp) {
                header.imports.push({ name: imp[1].replace(/`/g, ""), star: !!imp[2], alias: imp[3]?.replace(/`/g, ""), line: i });
            } else {
                header.bodyLine = comment >= 0 ? comment : i;
                break;
            }
        }
        comment = -1;
    }
    return header;
}

function depthChange(line: string): number {
    let depth = 0;
    for (const c of line) {
        if (c === "(" || c === "[") { depth++; } else if (c === ")" || c === "]") { depth--; }
    }
    return depth;
}

interface LayoutEntry { prefix: string; subpackages: boolean; alias: boolean }

const layouts = new Map<string, LayoutEntry[]>();

/** `*,java.**,^` → entries; `|` (a blank line between groups) is ignored. */
function parseLayout(layout: string): LayoutEntry[] {
    let entries = layouts.get(layout);
    if (!entries) {
        entries = layout.split(",").map(s => s.trim()).filter(s => s && s !== "|").map(s => {
            const alias = s.startsWith("^");
            const pattern = alias ? s.slice(1) : s;
            return { alias, subpackages: !pattern.endsWith(".*") || pattern.endsWith(".**"), prefix: pattern.replace(/\.?\*+$/, "") };
        });
        if (!entries.length) { entries = [{ prefix: "", subpackages: true, alias: false }]; }
        layouts.set(layout, entries);
    }
    return entries;
}

type Sortable = { name: string; alias?: string; star?: boolean };

/** Index of the layout entry an import belongs to: the alias entry, else the most specific package entry. */
function group(imp: Sortable, entries: LayoutEntry[], ignoreAlias: boolean): number {
    const parent = imp.star ? imp.name : imp.name.slice(0, Math.max(0, imp.name.lastIndexOf(".")));
    // A layout without an alias entry (`*`) sorts alias imports with the others.
    const asAlias = !!imp.alias && !ignoreAlias && entries.some(e => e.alias && !e.prefix);
    let best = -1;
    let bestScore = -1;
    entries.forEach((e, i) => {
        let score: number;
        if (asAlias) {
            if (!e.alias || e.prefix) { return; }
            score = 0;
        } else if (e.alias) {
            return;
        } else if (!e.prefix) {
            score = 0;
        } else if (e.subpackages ? imp.name === e.prefix || imp.name.startsWith(`${e.prefix}.`) : parent === e.prefix) {
            score = 1 + e.prefix.length + (e.subpackages ? 0 : 1);
        } else {
            return;
        }
        if (score > bestScore) { best = i; bestScore = score; }
    });
    return best < 0 ? entries.length : best;
}

const sortText = (i: Sortable) => `${i.name}${i.star ? ".*" : ""}${i.alias ? ` as ${i.alias}` : ""}`;

/**
 * Negative when `a` belongs before `b` under `layout` (an `ij_kotlin_imports_layout` value). Like IntelliJ: by
 * layout group, then by the text of the import in ASCII order; two alias imports are grouped by their packages.
 */
export function compareImports(a: Sortable, b: Sortable, layout: string = INTELLIJ_LAYOUT): number {
    const entries = parseLayout(layout);
    const ignoreAlias = !!a.alias && !!b.alias;
    const byGroup = group(a, entries, ignoreAlias) - group(b, entries, ignoreAlias);
    if (byGroup) { return byGroup; }
    const x = sortText(a);
    const y = sortText(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

export interface ImportInsertion {
    line: number;
    character: number;
    newText: string;
}

/** Plans `import` statements for one version of a file; the header is parsed once. */
export class ImportPlanner {
    readonly header: Header;
    private readonly lines: string[];

    constructor(text: string, private readonly layout: string = INTELLIJ_LAYOUT) {
        this.lines = text.split("\n");
        this.header = parseHeader(text);
    }

    /** Whether the file can already use `fqName` by its simple name. */
    isImported(fqName: string): boolean {
        const dot = fqName.lastIndexOf(".");
        const parent = dot < 0 ? "" : fqName.slice(0, dot);
        if (parent === this.header.packageName || DEFAULT_IMPORT_PACKAGES.includes(parent)) { return true; }
        return this.header.imports.some(i => i.star ? i.name === parent : !i.alias && i.name === fqName);
    }

    /** The name an explicit import binds `simple` to (`import a.B`, `import a.C as B`), if any. */
    explicitlyImported(simple: string): string | undefined {
        return this.header.imports.find(i => !i.star && (i.alias ?? i.name.slice(i.name.lastIndexOf(".") + 1)) === simple)?.name;
    }

    /**
     * Where and how to add `import <fqName>`: after the last import that sorts before it, else above the first
     * import, else below the package directive. `undefined` when the name is already imported.
     */
    plan(fqName: string): ImportInsertion | undefined {
        if (this.isImported(fqName)) { return undefined; }
        const { header, lines } = this;
        const statement = `import ${escapeName(fqName)}`;
        const at = (line: number, before: string, after: string): ImportInsertion => {
            // Past the last line (the file does not end with a line break): append to the last line instead.
            if (line >= lines.length) {
                const last = lines.length - 1;
                return { line: last, character: lines[last].replace(/\r$/, "").length, newText: `\n${before}${statement}` };
            }
            return { line, character: 0, newText: `${before}${statement}\n${after}` };
        };
        if (header.imports.length) {
            let previous: HeaderImport | undefined;
            for (const i of header.imports) {
                if (compareImports(i, { name: fqName }, this.layout) <= 0) { previous = i; }
            }
            return at(previous ? previous.line + 1 : header.imports[0].line, "", "");
        }
        const blank = (line: number) => line >= lines.length || !lines[line].trim();
        const anchor = Math.max(header.packageLine, header.preambleLine);
        if (anchor >= 0) { return at(anchor + 1, "\n", blank(anchor + 1) ? "" : "\n"); }
        return at(header.bodyLine < lines.length ? header.bodyLine : 0, "", "\n");
    }
}

/** One-off form of {@link ImportPlanner.plan}. */
export function importPlan(text: string, fqName: string, layout: string = INTELLIJ_LAYOUT): ImportInsertion | undefined {
    return new ImportPlanner(text, layout).plan(fqName);
}

const KEYWORDS = new Set([
    "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null",
    "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val", "var", "when", "while",
]);

/** Backticks around segments that are hard keywords or not plain identifiers. */
export function escapeName(fqName: string): string {
    return fqName.split(".").map(s => KEYWORDS.has(s) || !/^[A-Za-z_]\w*$/.test(s) ? `\`${s}\`` : s).join(".");
}

const editorConfigs = new Map<string, { layout: string | undefined; read: number }>();

/** The `ij_kotlin_imports_layout` that applies to files in `dir`, from the nearest `.editorconfig` that sets it. */
export function editorConfigLayout(dir: string): string | undefined {
    const cached = editorConfigs.get(dir);
    if (cached && Date.now() - cached.read < 5000) { return cached.layout; }
    let layout: string | undefined;
    for (let d = dir; ; d = path.dirname(d)) {
        let content: string | undefined;
        try { content = fs.readFileSync(path.join(d, ".editorconfig"), "utf8"); } catch { content = undefined; }
        if (content !== undefined) {
            layout = /^\s*ij_kotlin_imports_layout\s*=\s*(.+?)\s*$/m.exec(content)?.[1];
            if (layout || /^\s*root\s*=\s*true\s*$/mi.test(content)) { break; }
        }
        if (path.dirname(d) === d) { break; }
    }
    editorConfigs.set(dir, { layout, read: Date.now() });
    return layout;
}
