import { compareImports, HeaderImport, INTELLIJ_LAYOUT, parseHeader } from "./imports";

/** Functions Kotlin calls without their name appearing: operators, delegates, destructuring, `for` loops. */
const CONVENTIONS = new Set([
    "plus", "minus", "times", "div", "rem", "mod", "rangeTo", "rangeUntil", "contains", "get", "set", "invoke", "iterator", "next",
    "hasNext", "compareTo", "equals", "getValue", "setValue", "provideDelegate", "unaryMinus", "unaryPlus", "not", "inc", "dec",
    "plusAssign", "minusAssign", "timesAssign", "divAssign", "remAssign", "modAssign",
]);

export interface OrganizedImports {
    /** First and last line (inclusive) of the import block that is replaced. */
    startLine: number;
    endLine: number;
    /** The new block, one import per line, without a trailing line break. */
    newText: string;
    removed: string[];
}

/**
 * Sorts the imports by the layout, drops duplicates and drops imports whose name is not used below the header.
 * Deliberately cautious: a name counts as used when it appears anywhere in the body, comments and strings
 * included (KDoc links), and star imports and operator functions are always kept. `undefined` when there is
 * nothing to change, or when the block has comments between imports (they are left for the user to arrange).
 */
export function organizeImports(text: string, layout: string = INTELLIJ_LAYOUT): OrganizedImports | undefined {
    const header = parseHeader(text);
    if (!header.imports.length) { return undefined; }
    const lines = text.split("\n");
    const startLine = header.imports[0].line;
    const endLine = header.imports[header.imports.length - 1].line;
    const importLines = new Set(header.imports.map(i => i.line));
    for (let line = startLine; line <= endLine; line++) {
        if (!importLines.has(line) && lines[line].trim()) { return undefined; }
    }
    const body = lines.slice(header.bodyLine).join("\n");
    const used = (i: HeaderImport) => {
        if (i.star) { return true; }
        const name = i.alias ?? i.name.slice(i.name.lastIndexOf(".") + 1);
        if (CONVENTIONS.has(name) || /^component\d+$/.test(name)) { return true; }
        return new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$&")}(?![\\w$])`).test(body);
    };
    const statement = (i: HeaderImport) => lines[i.line].trim().replace(/\s*;\s*$/, "");
    const seen = new Set<string>();
    const kept: HeaderImport[] = [];
    const removed: string[] = [];
    for (const i of header.imports) {
        const key = `${i.name}${i.star ? ".*" : ""}${i.alias ? ` as ${i.alias}` : ""}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        if (used(i)) { kept.push(i); } else { removed.push(key); }
    }
    kept.sort((a, b) => compareImports(a, b, layout));
    const newText = kept.map(statement).join("\n");
    const oldText = lines.slice(startLine, endLine + 1).map(l => l.replace(/\r$/, "")).join("\n");
    return newText === oldText ? undefined : { startLine, endLine, newText, removed };
}
