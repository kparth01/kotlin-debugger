import { ClassIndex, FileContext, INTERNAL_PACKAGE } from "./classIndex";
import { parseHeader } from "./imports";
import { Inference, mask } from "./inference";
import { TypeSystem } from "./typeSystem";
import { renderType } from "./types";

/** A name used in a file that nothing in scope explains, and the imports that would. */
export interface MissingImport {
    name: string;
    /** Offsets of the identifier. */
    start: number;
    end: number;
    /** Dotted names to import, best first. */
    candidates: string[];
}

const MAX_CANDIDATES = 10;

/** Words that are followed by `(` or `{` without being calls. */
const NOT_CALLS = new Set([
    "if", "else", "for", "while", "do", "when", "try", "catch", "finally", "return", "throw", "in", "is", "as", "fun", "val", "var",
    "class", "object", "interface", "typealias", "this", "super", "null", "true", "false", "break", "continue", "package", "import",
    "constructor", "init", "get", "set", "where", "by", "companion", "typeof", "it", "field", "value",
]);

/**
 * Names that need an import, found without compiling: classes (types, constructors, annotations, `Name.`), calls of
 * top-level functions, and members after a `.` that only an extension outside the file's imports provides. A name is
 * reported only when at least one import would explain it, so unknown names are left alone.
 */
export function missingImports(text: string, file: FileContext, types: TypeSystem, index: ClassIndex, budgetMs = 250): MissingImport[] {
    // Comments, strings and backticked names (`fun \`a test name\`()`) are blanked; offsets are kept.
    const masked = mask(text).replace(/`[^`\n]*`/g, quoted => " ".repeat(quoted.length));
    const bodyLine = parseHeader(text).bodyLine;
    let bodyStart = 0;
    for (let line = 0; line < bodyLine; line++) {
        const next = text.indexOf("\n", bodyStart);
        if (next < 0) { return []; }
        bodyStart = next + 1;
    }
    const declared = declaredNames(masked);
    // Names bound by an explicit import, and members of classes imported with `.*` (Java statics, object members).
    for (const i of file.imports) {
        if (!i.star) { declared.add(i.alias ?? i.name.slice(i.name.lastIndexOf(".") + 1)); continue; }
        const owner = classOfDottedName(i.name, index);
        if (owner) { index.members(owner).forEach(e => declared.add(e.name)); }
    }
    const inference = new Inference(text, file, types, p => index.hasPackage(p));
    const classes = new Map<string, string[] | undefined>();
    const calls = new Map<string, string[] | undefined>();
    const extensions = new Map<string, boolean>();
    const membersOf = new Map<string, Set<string>>();
    const inScope = (name: string, end: number) => {
        try {
            return inference.scopeEntries(end, name).some(e => e.name === name && !e.importName && e.kind !== "keyword" && e.kind !== "namedArgument");
        } catch {
            return true;
        }
    };
    const out: MissingImport[] = [];
    const deadline = Date.now() + budgetMs;
    const identifier = /[A-Za-z_]\w*/g;
    identifier.lastIndex = bodyStart;
    let count = 0;
    for (let m = identifier.exec(masked); m; m = identifier.exec(masked)) {
        if (++count % 32 === 0 && Date.now() > deadline) { break; }
        const name = m[0];
        const start = m.index;
        const end = start + name.length;
        // part of a number (`0xFF`, `10L`), a backticked name, or a label (`this@Outer`, `loop@`)
        if (start > 0 && /[\w`]/.test(masked[start - 1]) || masked[end] === "@") { continue; }
        if (masked[start - 1] === "@" && /\w/.test(masked[start - 2] ?? "")) { continue; }
        let p = start - 1;
        while (p >= 0 && /\s/.test(masked[p])) { p--; }
        const previous = p >= 0 ? masked[p] : "";
        if (previous === ":" && masked[p - 1] === ":") { continue; }
        let candidates: string[] | undefined;
        if (previous === "." && masked[p - 1] !== ".") {
            candidates = extensionCandidates(name, p);
        } else if (/^[A-Z]/.test(name)) {
            if (declared.has(name)) { continue; }
            if (!classes.has(name)) { classes.set(name, classCandidates(name)); }
            candidates = classes.get(name);
            if (candidates && inScope(name, end)) { candidates = undefined; }
        } else if (!NOT_CALLS.has(name) && !declared.has(name) && isCall(masked, end)) {
            if (!calls.has(name)) { calls.set(name, callableCandidates(name)); }
            candidates = calls.get(name);
            if (candidates && inScope(name, end)) { candidates = undefined; }
        }
        if (candidates?.length) { out.push({ name, start, end, candidates: candidates.slice(0, MAX_CANDIDATES) }); }
    }
    return out;

    function classCandidates(name: string): string[] | undefined {
        if (types.resolveClass([name], file)) { return undefined; }
        const functions = types.topLevelNamed(name, file);
        if (functions.some(f => f.visible)) { return undefined; }
        return distinct([...types.importableClasses(name), ...functions.map(f => `${f.member.pkg.replace(/\//g, ".")}.${name}`)]);
    }

    function callableCandidates(name: string): string[] | undefined {
        const functions = types.topLevelNamed(name, file);
        if (!functions.length || functions.some(f => f.visible)) { return undefined; }
        return distinct(functions.filter(f => !INTERNAL_PACKAGE.test(f.member.pkg)).map(f => `${f.member.pkg.replace(/\//g, ".")}.${name}`));
    }

    /** `receiver.name` where the receiver's type has no such member and only extensions that need an import fit. */
    function extensionCandidates(name: string, dot: number): string[] | undefined {
        let importable = extensions.get(name);
        if (importable === undefined) {
            importable = types.importableExtensions(name, file).length > 0;
            extensions.set(name, importable);
        }
        if (!importable) { return undefined; }
        try {
            const receiver = inference.receiver(dot);
            if (receiver?.kind !== "value") { return undefined; }
            const key = renderType(receiver.type);
            let members = membersOf.get(key);
            if (!members) {
                members = new Set(types.members(receiver.type).map(member => member.name));
                membersOf.set(key, members);
            }
            if (members.has(name)) { return undefined; }
            const fitting = types.extensions(receiver.type, file).filter(e => e.name === name);
            if (!fitting.length || fitting.some(e => !e.importName)) { return undefined; }
            return distinct(fitting.map(e => e.importName!));
        } catch {
            return undefined;
        }
    }
}

/** `org.junit.Assert` → `org/junit/Assert`, `a.Outer.Inner` → `a/Outer$Inner`; `undefined` for a package. */
function classOfDottedName(name: string, index: ClassIndex): string | undefined {
    const segments = name.split(".");
    for (let i = segments.length - 1; i >= 0; i--) {
        const binary = [...segments.slice(0, i), segments.slice(i).join("$")].join("/");
        if (index.has(binary)) { return binary; }
    }
    return undefined;
}

function distinct(names: string[]): string[] | undefined {
    const unique = [...new Set(names)];
    return unique.length ? unique : undefined;
}

/** `name(`, `name {` or `name<T>(` on the same line. */
function isCall(masked: string, end: number): boolean {
    const rest = /^[ \t]*(?:<[\w\s,.?<>*]{1,80}>[ \t]*)?([({])/.exec(masked.slice(end, end + 100));
    return !!rest;
}

/** Names the file declares itself: classes, type parameters, functions, properties, parameters, enum entries. */
function declaredNames(masked: string): Set<string> {
    const names = new Set<string>();
    const all = (pattern: RegExp, use: (m: RegExpExecArray) => void) => {
        for (let m = pattern.exec(masked); m; m = pattern.exec(masked)) { use(m); }
    };
    all(/\b(?:class|interface|object|typealias)\s+([A-Za-z_]\w*)/g, m => names.add(m[1]));
    all(/\b(?:val|var|fun)\s+(?:<[^>]*>\s*)?(?:[\w<>?,.\s]*\.)?([A-Za-z_]\w*)/g, m => names.add(m[1]));
    // parameters, properties and destructured names: `name:` (not `name::`)
    all(/([A-Za-z_]\w*)\s*:(?!:)/g, m => names.add(m[1]));
    // lambda parameters and loop variables
    all(/\{\s*\(?([\w\s,]+?)\)?\s*->/g, m => m[1].split(",").forEach(n => names.add(n.trim())));
    all(/\bfor\s*\(\s*\(?([\w\s,]+?)\)?\s+in\b/g, m => m[1].split(",").forEach(n => names.add(n.trim())));
    const typeParameters = (list: string) => {
        for (const part of list.split(",")) {
            const name = /^\s*(?:(?:reified|in|out)\s+)*([A-Za-z_]\w*)/.exec(part)?.[1];
            if (name) { names.add(name); }
        }
    };
    all(/\b(?:fun|val|var)\s*<([^>]*)>/g, m => typeParameters(m[1]));
    all(/\b(?:class|interface|typealias)\s+\w+\s*<([^>]*)>/g, m => typeParameters(m[1]));
    // enum entries: identifiers at the top of the body, up to `;`
    all(/\benum\s+class\s+\w+[^{]*\{/g, m => {
        let depth = 0;
        let expect = true;
        for (let i = m.index + m[0].length; i < masked.length; i++) {
            const c = masked[i];
            if (c === "(" || c === "{" || c === "[") { depth++; } else if (c === ")" || c === "]") { depth--; } else if (c === "}") {
                if (depth === 0) { break; }
                depth--;
            } else if (depth === 0 && c === ";") {
                break;
            } else if (depth === 0 && c === ",") {
                expect = true;
            } else if (depth === 0 && expect && /[A-Za-z_]/.test(c)) {
                const entry = /^\w+/.exec(masked.slice(i))![0];
                names.add(entry);
                i += entry.length - 1;
                expect = false;
            }
        }
    });
    return names;
}
