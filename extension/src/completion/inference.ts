import { Entry, FileContext } from "./classIndex";
import { ClassKind } from "./kotlinMetadata";
import { FoundMember, Member, memberKey, TypeSystem } from "./typeSystem";
import { ANY, argType, classIdToBinary, classType, isFunctionType, KArg, KType, renderType, substitute, unify } from "./types";

/*
 * Static type of the expression before a `.`, inferred from the document text: declarations with types or
 * initializers, parameters, `for` variables, lambda parameters (`it`), `this`, calls (members, extensions,
 * constructors, top-level functions) with generic type arguments bound from receivers and arguments.
 * Heuristic, not a Kotlin parser: what it cannot type, it leaves alone.
 */

export type Range = [start: number, end: number];

export interface SourceParam { name: string; type?: Range; vararg: boolean; hasDefault: boolean }

/** A declaration parsed from Kotlin source; types are text ranges, resolved later with `typeAt`/`valueTypeAt`. */
export interface SourceMember {
    kind: "function" | "property";
    name: string;
    at: number;
    typeParams: string[];
    receiver?: Range;
    params: SourceParam[];
    /** Declared type (or return type). */
    type?: Range;
    /** Expression body or initializer. */
    body?: Range;
    /** `by lazy {`: the brace. */
    lazy?: number;
    blockBody: boolean;
    isVar: boolean;
    suspend: boolean;
    visible: boolean;
}

export interface SourceClass {
    id: string;
    kind: ClassKind;
    typeParams: string[];
    supertypes: Range[];
    members: SourceMember[];
    primaryConstructor?: SourceParam[];
    data: boolean;
    enumEntries: string[];
    companion?: string;
    visible: boolean;
}

export interface SourceDeclarations { classes: SourceClass[]; topLevel: SourceMember[] }

export type Value =
    | { kind: "value"; type: KType }
    | { kind: "class"; id: string }
    | { kind: "package"; path: string };

interface Group { open: string; start: number; end: number }

type Token =
    | { t: "id"; v: string; at: number }
    | { t: "str" | "char"; at: number }
    | { t: "num"; v: string; at: number }
    | { t: "group"; g: Group; at: number }
    | { t: "op"; v: string; at: number };

interface Call { typeArgs?: Group; args?: Group; lambda?: Group }

type Atom =
    | { kind: "name"; name: string; at: number; call?: Call }
    | { kind: "this"; at: number }
    | { kind: "literal"; type: KType }
    | { kind: "paren"; g: Group };

type Selector =
    | { kind: "member"; name: string; at: number; call?: Call }
    | { kind: "index"; g: Group }
    | { kind: "notNull" };

interface Chain { atom: Atom; selectors: Selector[] }

type Declaration =
    | { kind: "typed"; at: number; typeStart: number; typeEnd: number }
    | { kind: "init"; at: number; start: number; end: number }
    | { kind: "lazy"; at: number; brace: number }
    | { kind: "for"; at: number; start: number; end: number }
    | { kind: "lambda"; at: number; brace: number; index: number }
    /** `val (a, b) = x`, `for ((a, b) in xs)`, `{ (a, b) -> }`: `componentN()` of the source. */
    | { kind: "destructure"; at: number; component: number; source: Declaration };

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const STOP_KEYWORDS = new Set([
    "return", "throw", "in", "is", "as", "if", "else", "when", "while", "for", "do", "try", "catch", "finally",
    "val", "var", "fun", "class", "object", "interface", "package", "import", "typealias", "by", "where",
]);
const MAX_DEPTH = 8;
const KEYWORDS = [
    "val", "var", "fun", "if", "else", "when", "for", "while", "do", "return", "break", "continue", "null", "true", "false",
    "this", "super", "class", "interface", "object", "is", "as", "in", "try", "catch", "finally", "throw", "import", "package",
    "typealias", "override", "private", "protected", "internal", "public", "open", "abstract", "data", "sealed", "enum",
    "companion", "suspend", "inline", "lateinit", "const", "by", "init", "constructor", "vararg", "operator", "infix",
];
const DECLARATION = new RegExp(
    "(?:@[\\w.:]+(?:\\s*\\([^()]*\\))?\\s*|\\b(?:public|private|protected|internal|open|abstract|final|override|data|sealed|enum|annotation|" +
    "inner|value|inline|suspend|operator|infix|tailrec|external|const|lateinit|actual|expect|companion|fun(?=\\s+interface))\\s+)*" +
    "\\b(class|interface|object|fun|val|var|typealias|init|constructor)\\b", "y");
const BINARY = new Set(["+", "-", "*", "/", "%", "..", "..<", "==", "!=", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "?:"]);
const UNARY = new Set(["-", "+", "!", "++", "--"]);
const BOOLEAN_RESULT = new Set(["==", "!=", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "in", "!in", "is"]);
const OPERATOR_FUNCTIONS: Record<string, string> = { "+": "plus", "-": "minus", "*": "times", "/": "div", "%": "rem", "..": "rangeTo", "..<": "rangeUntil" };

export class Inference {
    private readonly text: string;
    private readonly source: string;
    private readonly lambdaTypes = new Map<number, KType | undefined>();
    private readonly thisTypes = new Map<number, KType | undefined>();
    private readonly memberCache = new Map<string, Member[]>();

    constructor(source: string, private readonly file: FileContext, private readonly types: TypeSystem,
        private readonly hasPackage: (path: string) => boolean) {
        this.source = source;
        this.text = mask(source);
    }

    /**
     * Completion without a receiver at `offset` (the word typed so far is `prefix`): locals and parameters in scope,
     * named arguments of the enclosing call, members of `this`, top-level declarations and keywords.
     */
    scopeEntries(offset: number, prefix: string): Entry[] {
        const accept = (name: string) => !prefix || name[0]?.toLowerCase() === prefix[0].toLowerCase();
        const entries: Entry[] = [];
        const call = this.callAt(offset - prefix.length);
        if (call?.argumentText !== undefined && /^\s*$/.test(call.argumentText)) {
            const seen = new Set<string>();
            for (const f of call.functions) {
                for (const p of f.params) {
                    if (!p.name || seen.has(p.name) || !accept(p.name)) { continue; }
                    seen.add(p.name);
                    entries.push({ kind: "namedArgument", name: p.name, type: renderType(p.type), group: 0 });
                }
            }
        }
        for (const name of this.localNames(offset)) {
            if (!accept(name)) { continue; }
            const decl = this.declaration(name, offset);
            if (!decl) { continue; }
            let type: KType | undefined;
            try { type = this.declarationType(decl, 0); } catch { type = undefined; }
            entries.push({ kind: "variable", name, type: type && renderType(type), isVar: false, group: 0 });
        }
        if (accept("it") && this.enclosingLambda(offset, true) >= 0) {
            const t = this.variableType("it", offset, 0);
            if (t) { entries.push({ kind: "variable", name: "it", type: renderType(t), group: 0 }); }
        }
        const self = this.thisType(offset, 0);
        if (self) {
            for (const m of this.types.members(self)) {
                if (m.owner !== "kotlin/Any" && accept(m.name)) { entries.push({ ...entry(m), group: 1 }); }
            }
        }
        for (const { member, visible } of this.types.topLevelMatching(this.file, accept)) {
            if (!visible && prefix.length < 2) { continue; }
            const dotted = member.pkg.replace(/\//g, ".");
            entries.push({ ...entry({ ...member, inherited: false }), pkg: dotted, importName: visible ? undefined : `${dotted}.${member.name}`, group: visible ? 2 : 5 });
        }
        for (const k of KEYWORDS) {
            if (accept(k)) { entries.push({ kind: "keyword", name: k, group: 6 }); }
        }
        return entries;
    }

    /** Names declared before `offset` (locals, parameters, loop and lambda variables); scope is checked by the caller. */
    private localNames(offset: number): Set<string> {
        const t = this.text.slice(0, offset);
        const names = new Set<string>();
        const modifiers = "(?:(?:private|protected|internal|public|override|open|final|vararg|noinline|crossinline|val|var)\\s+)*";
        const patterns = [
            /\b(?:val|var)\s+([A-Za-z_]\w*)/g,
            new RegExp(`[(,{]\\s*(?:@[\\w.]+(?:\\([^()]*\\))?\\s*)*${modifiers}([A-Za-z_]\\w*)\\s*:(?!:)`, "g"),
            /\bfor\s*\(\s*([A-Za-z_]\w*)\s+in\b/g,
        ];
        for (const re of patterns) { for (const m of t.matchAll(re)) { names.add(m[1]); } }
        for (const m of t.matchAll(/(?:\{|\b(?:val|var)|\bfor\s*\()\s*\(?\s*((?:[A-Za-z_]\w*\s*,\s*)+[A-Za-z_]\w*)\s*\)?\s*(?:->|=|\bin\b)/g)) {
            for (const n of m[1].split(",")) { names.add(n.trim()); }
        }
        for (const m of t.matchAll(/\{\s*([A-Za-z_]\w*)\s*->/g)) { names.add(m[1]); }
        names.delete("it");
        return names;
    }

    /** The call whose argument list contains `offset`: its candidate signatures and the argument being typed. */
    callAt(offset: number): { functions: Member[]; argument: number; named?: string; argumentText?: string } | undefined {
        const t = this.text;
        const open = this.enclosingOpen(offset - 1, "(");
        if (open < 0 || this.enclosingBraces(offset).some(b => b > open)) { return undefined; }
        let q = skipSpaceBack(t, open - 1, true);
        if (t[q] === ">") {
            const angle = this.matchAngleBackward(q);
            if (angle < 0) { return undefined; }
            q = skipSpaceBack(t, angle - 1, true);
        }
        let nameStart = q + 1;
        while (nameStart > 0 && /\w/.test(t[nameStart - 1])) { nameStart--; }
        const name = t.slice(nameStart, q + 1);
        if (!/^[A-Za-z_]\w*$/.test(name) || STOP_KEYWORDS.has(name) || ["catch", "constructor", "init"].includes(name)) { return undefined; }
        if (/\bfun\s+(?:<[^>]*>\s*)?(?:[\w.<>?, ]+\.)?$/.test(t.slice(Math.max(0, nameStart - 120), nameStart))) { return undefined; }
        const dot = skipSpaceBack(t, nameStart - 1);
        let functions: Member[];
        if (t[dot] === ".") {
            const receiver = this.receiver(dot);
            if (!receiver) { return undefined; }
            const nested = receiver.kind === "class" ? this.types.nestedClass(receiver.id, name) : undefined;
            functions = nested ? this.constructorsOf(nested, name) : this.functions(receiver, name, nameStart);
        } else {
            const cls = /^[A-Z]/.test(name) ? this.types.resolveClass([name], this.file) : undefined;
            functions = cls ? this.constructorsOf(cls, name) : this.functions(undefined, name, nameStart);
        }
        let argument = 0;
        let argStart = open + 1;
        for (let i = open + 1, depth = 0; i < offset; i++) {
            const c = t[i];
            if (OPENERS[c]) { depth++; } else if (CLOSERS[c]) { depth--; }
            else if (c === "," && depth === 0) { argument++; argStart = i + 1; }
        }
        const argumentText = t.slice(argStart, offset);
        const named = /^\s*(\w+)\s*=(?!=)/.exec(argumentText)?.[1];
        return { functions, argument, named, argumentText };
    }

    private constructorsOf(id: string, name: string): Member[] {
        const self = this.types.selfType(id);
        return this.types.constructors(id).map(params => ({ kind: "function", name, typeParams: [], params, returnType: self, owner: id }));
    }

    /** A type written at `[start, end)`. */
    typeAt(start: number, end: number): KType | undefined {
        return this.parseType(start, end, start);
    }

    /** The type of the expression at `[start, end)`. */
    valueTypeAt(start: number, end: number): KType | undefined {
        const v = this.evalRegion(start, end, 0);
        return v?.kind === "value" ? v.type : undefined;
    }

    /** `by lazy { ... }`: the type of the lambda's last expression. */
    lazyTypeAt(brace: number): KType | undefined {
        const close = this.matchForward(brace);
        return close > 0 ? this.valueTypeAt(this.lastStatementStart(brace + 1, close), close) : undefined;
    }

    /** Classes (with members) and top-level declarations of the file. */
    declarations(): SourceDeclarations {
        const out: SourceDeclarations = { classes: [], topLevel: [] };
        this.parseBlock(0, this.text.length, undefined, this.file.packageName.replace(/\./g, "/"), out);
        return out;
    }

    /** True when `offset` is inside a comment or a string literal (outside `${...}`). */
    inCommentOrString(offset: number): boolean {
        return this.text[offset] !== this.source[offset];
    }

    /** The value of the expression that ends right before the `.` at `dot`. */
    receiver(dot: number, depth = 0): Value | undefined {
        let end = dot;
        if (this.text[end - 1] === "?") { end--; }
        const tokens = this.tokenize(this.regionStart(end), end);
        const start = chainStart(tokens);
        const chain = start === undefined ? undefined : parseChain(tokens.slice(start));
        return chain && this.evalChain(chain, depth);
    }

    // ---- evaluation

    private evalChain(chain: Chain, depth: number): Value | undefined {
        if (depth > MAX_DEPTH) { return undefined; }
        let value = this.evalAtom(chain.atom, depth);
        for (const s of chain.selectors) {
            if (!value) { return undefined; }
            value = this.select(value, s, depth);
        }
        return value;
    }

    private evalRegion(start: number, end: number, depth: number): Value | undefined {
        if (depth > MAX_DEPTH) { return undefined; }
        const tokens = this.tokenize(start, end);
        const as = tokens.findIndex(t => t.t === "id" && t.v === "as");
        if (as >= 0) {
            let typeStart = tokens[as].at + 2;
            if (this.text[typeStart] === "?") { typeStart++; }
            const type = this.parseType(typeStart, end, start);
            return type && { kind: "value", type };
        }
        if (tokens[0]?.t === "id" && ["if", "when", "try", "object"].includes(tokens[0].v)) { return undefined; }
        // Binary and infix operators, left to right: `a ?: b`, `x + 1`, `"a" to 1`, `0 until n`.
        const operands: Token[][] = [[]];
        const operators: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            const current = operands[operands.length - 1];
            const last = current[current.length - 1];
            const afterOperand = !!last && !isOp(last, ".") && !isOp(last, "?.") && !(last.t === "op" && UNARY.has(last.v));
            if (afterOperand && tok.t === "op" && BINARY.has(tok.v)) {
                operators.push(tok.v);
                operands.push([]);
            } else if (afterOperand && tok.t === "id") {
                operators.push(tok.v);
                operands.push([]);
            } else if (afterOperand && isOp(tok, "!") && tokens[i + 1]?.t === "id" && ["in", "is"].includes((tokens[i + 1] as { v: string }).v)) {
                operators.push("!in");
                operands.push([]);
                i++;
            } else {
                current.push(tok);
            }
        }
        let left = this.evalOperand(operands[0], depth);
        for (let k = 0; k < operators.length; k++) {
            const op = operators[k];
            if (BOOLEAN_RESULT.has(op)) {
                left = { kind: "value", type: classType("kotlin/Boolean") };
                continue;
            }
            const right = this.evalOperand(operands[k + 1], depth);
            if (op === "?:") {
                left = left?.kind === "value" ? { kind: "value", type: { ...left.type, nullable: false } } : right;
                continue;
            }
            if (left?.kind !== "value") { return undefined; }
            const argType = right?.kind === "value" ? right.type : undefined;
            const candidates = this.functions(left, OPERATOR_FUNCTIONS[op] ?? op, -1, depth).filter(f => f.params.length === 1);
            const fn = candidates.find(f => !!argType && f.params[0].type.id === argType.id) ?? candidates[0];
            if (!fn) { return undefined; }
            left = { kind: "value", type: this.withArgumentTypes(fn, argType ? [argType] : []) };
        }
        return left;
    }

    /** An operand with optional prefix operators (`-x`, `!flag`). */
    private evalOperand(tokens: Token[] | undefined, depth: number): Value | undefined {
        if (!tokens?.length) { return undefined; }
        let i = 0;
        let not = false;
        while (tokens[i]?.t === "op" && UNARY.has((tokens[i] as { v: string }).v)) {
            not ||= isOp(tokens[i], "!");
            i++;
        }
        if (not) { return { kind: "value", type: classType("kotlin/Boolean") }; }
        const chain = parseChain(tokens.slice(i));
        return chain && this.evalChain(chain, depth);
    }

    private withArgumentTypes(fn: Member, argTypes: KType[]): KType {
        const params = new Set(fn.typeParams.map(p => p.name));
        if (!params.size) { return fn.returnType; }
        const bindings = new Map<string, KType>();
        argTypes.forEach((t, i) => { if (fn.params[i]) { unify(fn.params[i].type, t, params, bindings); } });
        return substitute(fn.returnType, bindings);
    }

    private evalAtom(atom: Atom, depth: number): Value | undefined {
        switch (atom.kind) {
            case "literal": return { kind: "value", type: atom.type };
            case "paren": return this.evalRegion(atom.g.start + 1, atom.g.end, depth + 1);
            case "this": {
                const type = this.thisType(atom.at, depth);
                return type && { kind: "value", type };
            }
        }
        if (atom.call) { return this.call(undefined, atom.name, atom.call, atom.at, depth); }
        const type = this.variableType(atom.name, atom.at, depth);
        if (type) { return { kind: "value", type }; }
        const cls = this.types.resolveClass([atom.name], this.file);
        if (cls) { return { kind: "class", id: cls }; }
        if (this.hasPackage(atom.name)) { return { kind: "package", path: atom.name }; }
        const top = this.types.topLevel(atom.name, this.file).find(m => m.kind === "property");
        return top && { kind: "value", type: top.returnType };
    }

    private select(value: Value, s: Selector, depth: number): Value | undefined {
        if (s.kind === "notNull") { return value.kind === "value" ? { kind: "value", type: { ...value.type, nullable: false } } : undefined; }
        if (s.kind === "index") {
            if (value.kind !== "value") { return undefined; }
            const get = this.functions(value, "get", s.g.start).find(f => f.params.length >= 1);
            return get && { kind: "value", type: get.returnType };
        }
        if (value.kind === "package") {
            const path = `${value.path}/${s.name}`;
            if (this.types.exists(path)) {
                return s.call ? { kind: "value", type: this.types.selfType(path) } : { kind: "class", id: path };
            }
            return this.hasPackage(path) ? { kind: "package", path } : undefined;
        }
        if (value.kind === "class") {
            const nested = this.types.nestedClass(value.id, s.name);
            if (nested) { return s.call ? { kind: "value", type: this.types.selfType(nested) } : { kind: "class", id: nested }; }
        }
        if (s.call) { return this.call(value, s.name, s.call, s.at, depth); }
        const property = this.properties(value, s.name)[0];
        return property && { kind: "value", type: property.returnType };
    }

    /** `name(args) { lambda }` on `receiver` (or unqualified when undefined). */
    private call(receiver: Value | undefined, name: string, call: Call, at: number, depth: number): Value | undefined {
        if (!receiver) {
            const local = this.localFunction(name, at, depth);
            if (local) { return { kind: "value", type: local }; }
            const cls = /^[A-Z]/.test(name) ? this.types.resolveClass([name], this.file) : undefined;
            if (cls) {
                const typeArgs = call.typeArgs ? this.typeList(call.typeArgs) : [];
                const self = this.types.selfType(cls);
                if (typeArgs.length) { return { kind: "value", type: { ...self, args: typeArgs.map((type): KArg => ({ variance: "", type })) } }; }
                return { kind: "value", type: this.constructed(cls, self, call, depth) };
            }
        }
        const argCount = (call.args ? splitArgs(this.text, call.args).length : 0) + (call.lambda ? 1 : 0);
        const fn = pickOverload(this.functions(receiver, name, at, depth), argCount, !!call.lambda);
        return fn && { kind: "value", type: this.callResult(fn, call, depth) };
    }

    /** `Pair("a", 1)` → `Pair<String, Int>`: class type parameters bound from constructor arguments. */
    private constructed(cls: string, self: KType, call: Call, depth: number): KType {
        const params = new Set(self.args.map(a => a.type?.param).filter((p): p is string => !!p));
        if (!params.size || !call.args) { return self; }
        const args = splitArgs(this.text, call.args);
        const ctor = this.types.constructors(cls).find(c => c.length === args.length) ?? this.types.constructors(cls)[0];
        if (!ctor) { return self; }
        const bindings = new Map<string, KType>();
        args.forEach((range, i) => {
            const param = (range.name ? ctor.find(p => p.name === range.name) : undefined) ?? ctor[i];
            if (!param || !mentions(param.type, params)) { return; }
            const v = this.evalRegion(range.start, range.end, depth + 1);
            if (v?.kind === "value") { unify(param.type, v.type, params, bindings); }
        });
        return substitute(self, bindings);
    }

    /** Binds the function's own type parameters from explicit type arguments, arguments and a trailing lambda. */
    private callResult(fn: Member, call: Call, depth: number): KType {
        const params = new Set(fn.typeParams.map(p => p.name));
        if (!params.size) { return fn.returnType; }
        const bindings = new Map<string, KType>();
        if (call.typeArgs) {
            this.typeList(call.typeArgs).forEach((t, i) => { if (fn.typeParams[i]) { bindings.set(fn.typeParams[i].name, t); } });
        }
        const args = call.args ? splitArgs(this.text, call.args) : [];
        args.forEach((range, i) => {
            const param = (range.name ? fn.params.find(p => p.name === range.name) : undefined) ?? fn.params[Math.min(i, fn.params.length - 1)];
            if (!param || !mentions(param.type, params)) { return; }
            if (this.text[skipSpace(this.text, range.start)] === "{" && isFunctionType(param.type)) {
                this.bindLambdaResult(param.type, skipSpace(this.text, range.start), params, bindings, depth);
                return;
            }
            const v = this.evalRegion(range.start, range.end, depth + 1);
            if (v?.kind === "value") { unify(param.type, v.type, params, bindings); }
        });
        const last = fn.params[fn.params.length - 1];
        if (call.lambda && last && isFunctionType(last.type)) {
            this.bindLambdaResult(substitute(last.type, bindings), call.lambda.start, params, bindings, depth);
        }
        return substitute(fn.returnType, bindings);
    }

    /** `map { it.title }`: the lambda's last expression binds the function type's result (`R`). */
    private bindLambdaResult(fnType: KType, brace: number, params: Set<string>, bindings: Map<string, KType>, depth: number) {
        const result = fnType.args[fnType.args.length - 1]?.type;
        if (!result || !mentions(result, params)) { return; }
        const close = this.matchForward(brace);
        if (close < 0) { return; }
        const arrow = this.lambdaArrow(brace, close);
        const bodyStart = arrow >= 0 ? arrow + 2 : brace + 1;
        const lastStart = this.lastStatementStart(bodyStart, close);
        const v = this.evalRegion(lastStart, close, depth + 1);
        if (v?.kind === "value") { unify(result, v.type, params, bindings); }
    }

    // ---- members of a value / class

    private allMembers(type: KType): Member[] {
        const key = renderType(type);
        let members = this.memberCache.get(key);
        if (!members) {
            members = [...this.types.members(type), ...this.types.extensions(type, this.file)];
            this.memberCache.set(key, members);
        }
        return members;
    }

    private functions(receiver: Value | undefined, name: string, at: number, depth = 0): Member[] {
        if (receiver?.kind === "value") {
            return this.allMembers(receiver.type).filter(m => m.kind === "function" && m.name === name);
        }
        if (receiver?.kind === "class") {
            return this.types.staticMembers(receiver.id).filter(m => m.kind === "function" && m.name === name);
        }
        if (receiver) { return []; }
        const self = this.thisType(at, depth);
        const implicit = self ? this.functions({ kind: "value", type: self }, name, at) : [];
        return [...implicit, ...this.types.topLevel(name, this.file).filter(m => m.kind === "function")];
    }

    private properties(receiver: Value, name: string): Member[] {
        if (receiver.kind === "value") {
            return this.allMembers(receiver.type).filter(m => m.kind === "property" && m.name === name);
        }
        return receiver.kind === "class" ? this.types.staticMembers(receiver.id).filter(m => m.kind === "property" && m.name === name) : [];
    }

    // ---- names

    private variableType(name: string, at: number, depth: number): KType | undefined {
        if (name === "it") {
            const brace = this.enclosingLambda(at, true);
            if (brace >= 0) { return this.lambdaParam(brace, 0, depth); }
        }
        const decl = this.declaration(name, at);
        if (decl) { return this.declarationType(decl, depth); }
        const self = this.thisType(at, depth);
        return self ? this.properties({ kind: "value", type: self }, name)[0]?.returnType : undefined;
    }

    private declarationType(decl: Declaration, depth: number): KType | undefined {
        {
            switch (decl.kind) {
                case "typed": return this.parseType(decl.typeStart, decl.typeEnd, decl.at);
                case "init": {
                    const v = this.evalRegion(decl.start, decl.end, depth + 1);
                    return v?.kind === "value" ? v.type : undefined;
                }
                case "lazy": {
                    const close = this.matchForward(decl.brace);
                    const v = close > 0 ? this.evalRegion(this.lastStatementStart(decl.brace + 1, close), close, depth + 1) : undefined;
                    return v?.kind === "value" ? v.type : undefined;
                }
                case "for": {
                    const v = this.evalRegion(decl.start, decl.end, depth + 1);
                    return v?.kind === "value" ? this.elementType(v.type) : undefined;
                }
                case "lambda": return this.lambdaParam(decl.brace, decl.index, depth);
                case "destructure": {
                    const whole = this.declarationType(decl.source, depth + 1);
                    const component = whole && pickOverload(this.functions({ kind: "value", type: whole }, `component${decl.component}`, -1), 0, false);
                    return component?.returnType;
                }
            }
        }
        return undefined;
    }

    /** `for (x in xs)`: `xs.iterator().next()`. */
    private elementType(type: KType): KType | undefined {
        const iterator = pickOverload(this.functions({ kind: "value", type }, "iterator", -1), 0, false)?.returnType;
        return iterator && pickOverload(this.functions({ kind: "value", type: iterator }, "next", -1), 0, false)?.returnType;
    }

    /** The nearest declaration of `name` before `at` whose scope contains `at`. */
    private declaration(name: string, at: number): Declaration | undefined {
        const t = this.text;
        const id = name.replace(/\$/g, "\\$");
        let best: Declaration | undefined;
        const take = (d: Declaration, scopeEnd: number) => {
            if (d.at < at && at <= scopeEnd && (!best || d.at > best.at)) { best = d; }
        };
        for (const m of t.matchAll(new RegExp(`\\b(?:val|var)\\s+${id}\\b`, "g"))) {
            const declAt = m.index!;
            if (declAt >= at) { break; }
            const p = skipSpace(t, declAt + m[0].length, true);
            const scopeEnd = this.blockEnd(declAt);
            if (t[p] === ":") {
                const [s, e] = this.typeExtent(p + 1);
                take({ kind: "typed", at: declAt, typeStart: s, typeEnd: e }, scopeEnd);
            } else if (t[p] === "=" && t[p + 1] !== "=") {
                take({ kind: "init", at: declAt, start: p + 1, end: this.statementEnd(p + 1) }, scopeEnd);
            } else {
                const lazy = /^by\s+lazy\s*(?:\([^)]*\)\s*)?\{/.exec(t.slice(p, p + 80));
                if (lazy) { take({ kind: "lazy", at: declAt, brace: p + lazy[0].length - 1 }, scopeEnd); }
            }
        }
        const modifiers = "(?:(?:private|protected|internal|public|override|open|final|vararg|noinline|crossinline|val|var)\\s+)*";
        for (const m of t.matchAll(new RegExp(`[(,{]\\s*(?:@[\\w.]+(?:\\([^()]*\\))?\\s*)*${modifiers}${id}\\s*:(?!:)`, "g"))) {
            const declAt = m.index! + 1;
            if (declAt >= at) { break; }
            const [s, e] = this.typeExtent(m.index! + m[0].length);
            take({ kind: "typed", at: declAt, typeStart: s, typeEnd: e }, this.parameterScopeEnd(m.index!));
        }
        for (const m of t.matchAll(new RegExp(`\\bfor\\s*\\(\\s*${id}\\s+in\\s+`, "g"))) {
            if (m.index! >= at) { break; }
            const open = t.indexOf("(", m.index!);
            const close = this.matchForward(open);
            if (close > 0) { take({ kind: "for", at: m.index!, start: m.index! + m[0].length, end: close }, this.bodyEnd(close + 1)); }
        }
        const names = `\\(\\s*((?:\\w+\\s*,\\s*)*)${id}\\s*(?:,\\s*\\w+\\s*)*\\)`;
        const component = (before: string | undefined) => (before ? before.split(",").length - 1 : 0) + 1;
        for (const m of t.matchAll(new RegExp(`\\b(?:val|var)\\s*${names}\\s*=(?!=)`, "g"))) {
            if (m.index! >= at) { break; }
            const start = m.index! + m[0].length;
            take({ kind: "destructure", at: m.index!, component: component(m[1]), source: { kind: "init", at: m.index!, start, end: this.statementEnd(start) } }, this.blockEnd(m.index!));
        }
        for (const m of t.matchAll(new RegExp(`\\bfor\\s*\\(\\s*${names}\\s+in\\s+`, "g"))) {
            if (m.index! >= at) { break; }
            const close = this.matchForward(t.indexOf("(", m.index!));
            if (close > 0) {
                const source: Declaration = { kind: "for", at: m.index!, start: m.index! + m[0].length, end: close };
                take({ kind: "destructure", at: m.index!, component: component(m[1]), source }, this.bodyEnd(close + 1));
            }
        }
        for (const m of t.matchAll(new RegExp(`\\{\\s*${names}\\s*->`, "g"))) {
            if (m.index! >= at) { break; }
            const close = this.matchForward(m.index!);
            const source: Declaration = { kind: "lambda", at: m.index!, brace: m.index!, index: 0 };
            take({ kind: "destructure", at: m.index!, component: component(m[1]), source }, close < 0 ? t.length : close);
        }
        for (const m of t.matchAll(new RegExp(`\\{\\s*((?:\\w+\\s*,\\s*)*)${id}\\s*(?:,\\s*\\w+\\s*)*->`, "g"))) {
            if (m.index! >= at) { break; }
            const index = m[1] ? m[1].split(",").length - 1 : 0;
            const close = this.matchForward(m.index!);
            take({ kind: "lambda", at: m.index!, brace: m.index!, index }, close < 0 ? t.length : close);
        }
        return best;
    }

    /** `fun name(...): Type` or `fun name(...) = expr` declared in the file. */
    private localFunction(name: string, at: number, depth: number): KType | undefined {
        const t = this.text;
        const m = [...t.matchAll(new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?${name.replace(/\$/g, "\\$")}\\s*\\(`, "g"))].pop();
        if (!m) { return undefined; }
        const close = this.matchForward(m.index! + m[0].length - 1);
        if (close < 0) { return undefined; }
        const p = skipSpace(t, close + 1);
        if (t[p] === ":") {
            const [s, e] = this.typeExtent(p + 1);
            return this.parseType(s, e, at);
        }
        if (t[p] === "=") {
            const v = this.evalRegion(p + 1, this.statementEnd(p + 1), depth + 1);
            return v?.kind === "value" ? v.type : undefined;
        }
        return p < t.length && t[p] === "{" ? classType("kotlin/Unit") : undefined;
    }

    // ---- this and lambdas

    /** `this` at `at`: the receiver of an enclosing `T.() -> R` lambda (`apply { }`), else the enclosing class. */
    private thisType(at: number, depth: number): KType | undefined {
        const braces = this.enclosingBraces(at);
        const key = braces[0] ?? -1;
        if (this.thisTypes.has(key)) { return this.thisTypes.get(key); }
        this.thisTypes.set(key, undefined);
        let result: KType | undefined;
        for (const brace of braces) {
            const cls = this.classOfBody(brace);
            if (cls) { result = this.types.selfType(cls); break; }
            const receiver = this.extensionReceiver(brace);
            if (receiver) { result = receiver; break; }
            if (depth > MAX_DEPTH || !this.isLambda(brace)) { continue; }
            const fnType = this.lambdaType(brace, depth + 1);
            if (fnType?.extensionFunction) { result = argType(fnType, 0); break; }
        }
        result ??= this.expressionBodyReceiver(at, braces[0] ?? -1);
        this.thisTypes.set(key, result);
        return result;
    }

    /** `fun Receiver.name(...) = expr`: `this` in `expr` (declared after the innermost enclosing brace). */
    private expressionBodyReceiver(at: number, enclosing: number): KType | undefined {
        const t = this.text;
        const from = Math.max(enclosing + 1, at - 3000);
        let found: RegExpExecArray | undefined;
        const header = /\bfun\s+(?:<[^{}]*?>\s*)?([A-Za-z_][\w.]*(?:<[^{}]*?>)?\??)\.[A-Za-z_]\w*\s*\(/g;
        header.lastIndex = from;
        for (let m = header.exec(t); m && m.index < at; m = header.exec(t)) { found = m; }
        if (!found) { return undefined; }
        const close = this.matchForward(found.index + found[0].length - 1);
        if (close < 0 || close > at) { return undefined; }
        let p = skipSpace(t, close + 1);
        if (t[p] === ":") { p = skipSpace(t, this.typeExtent(p + 1)[1]); }
        if (t[p] !== "=" || at > this.statementEnd(p + 1)) { return undefined; }
        const start = found.index + found[0].indexOf(found[1], 3);
        return this.parseType(start, start + found[1].length, found.index);
    }

    /** `fun <T> List<T>.name(...): R {`: the receiver is `this` in the body. */
    private extensionReceiver(brace: number): KType | undefined {
        const from = Math.max(0, brace - 400);
        const head = this.text.slice(from, brace);
        const m = /\bfun\s+(?:<[^{}]*?>\s*)?([A-Za-z_][\w.]*(?:<[^{}]*?>)?\??)\.[A-Za-z_]\w*\s*\([^{}]*$/.exec(head);
        if (!m) { return undefined; }
        const start = from + m.index + m[0].indexOf(m[1], 3);
        return this.parseType(start, start + m[1].length, brace);
    }

    private lambdaParam(brace: number, index: number, depth: number): KType | undefined {
        const fnType = this.lambdaType(brace, depth + 1);
        if (!fnType) { return undefined; }
        const offset = fnType.extensionFunction ? 1 : 0;
        return index + offset < fnType.args.length - 1 ? argType(fnType, index + offset) : undefined;
    }

    /** The function type expected for the lambda at `brace`: from the parameter of the called function. */
    private lambdaType(brace: number, depth: number): KType | undefined {
        if (this.lambdaTypes.has(brace)) { return this.lambdaTypes.get(brace); }
        this.lambdaTypes.set(brace, undefined);
        const result = depth > MAX_DEPTH ? undefined : this.computeLambdaType(brace, depth);
        this.lambdaTypes.set(brace, result);
        return result;
    }

    private computeLambdaType(brace: number, depth: number): KType | undefined {
        const t = this.text;
        const before = skipSpaceBack(t, brace - 1, true);
        let nameEnd: number;
        let args: Group | undefined;
        let position: number | "last";
        if (t[before] === ")") {
            const open = this.matchBackward(before);
            if (open < 0) { return undefined; }
            args = { open: "(", start: open, end: before };
            nameEnd = open;
            position = "last";
        } else if (/\w/.test(t[before] ?? "")) {
            nameEnd = before + 1;
            position = "last";
        } else if (t[before] === "(" || t[before] === ",") {
            const open = t[before] === "(" ? before : this.enclosingOpen(before, "(");
            const close = open >= 0 ? this.matchForward(open) : -1;
            if (close < 0) { return undefined; }
            args = { open: "(", start: open, end: close };
            nameEnd = open;
            position = splitArgs(t, args).findIndex(r => r.start <= brace && brace <= r.end);
        } else {
            return undefined;
        }
        let q = skipSpaceBack(t, nameEnd - 1, true);
        if (t[q] === ">") {
            const open = this.matchAngleBackward(q);
            if (open < 0) { return undefined; }
            q = skipSpaceBack(t, open - 1, true);
        }
        let nameStart = q + 1;
        while (nameStart > 0 && /\w/.test(t[nameStart - 1])) { nameStart--; }
        const name = t.slice(nameStart, q + 1);
        if (!name || STOP_KEYWORDS.has(name)) { return undefined; }
        const dot = skipSpaceBack(t, nameStart - 1);
        const receiver = t[dot] === "." ? this.receiver(dot, depth + 1) : undefined;
        if (t[dot] === "." && !receiver) { return undefined; }
        const argRanges = args ? splitArgs(t, args) : [];
        const total = argRanges.length + (position === "last" ? 1 : 0);
        const candidates = this.functions(receiver, name, nameStart, depth).filter(f => {
            const index = position === "last" ? f.params.length - 1 : position;
            return index >= 0 && isFunctionType(f.params[index]?.type);
        });
        const fn = pickOverload(candidates, total, position === "last") ?? candidates[0];
        if (!fn) { return undefined; }
        const index = position === "last" ? fn.params.length - 1 : position;
        const params = new Set(fn.typeParams.map(p => p.name));
        const bindings = new Map<string, KType>();
        argRanges.forEach((range, i) => {
            if (i === index || !params.size) { return; }
            const param = fn.params[i];
            if (!param || !mentions(param.type, params) || t[skipSpace(t, range.start)] === "{") { return; }
            const v = this.evalRegion(range.start, range.end, depth + 1);
            if (v?.kind === "value") { unify(param.type, v.type, params, bindings); }
        });
        return substitute(fn.params[index].type, bindings);
    }

    // ---- types written in the source

    private parseType(start: number, end: number, at: number): KType | undefined {
        const typeParams = this.typeParamsInScope(at);
        const parser = new TypeParser(this.text.slice(start, end), segments => {
            if (segments.length === 1 && typeParams.has(segments[0])) { return { param: segments[0], args: [], nullable: false }; }
            const id = this.types.resolveClass(segments, this.file);
            return id ? classType(id) : undefined;
        });
        return parser.type();
    }

    private typeList(g: Group): KType[] {
        return splitArgs(this.text, g).map(r => this.parseType(r.start, r.end, g.start) ?? ANY);
    }

    /** Type parameter names declared by enclosing functions and classes (`fun <T> f(...)`, `class Box<T>`). */
    private typeParamsInScope(at: number): Set<string> {
        const names = new Set<string>();
        const t = this.text;
        for (const m of t.slice(0, at).matchAll(/\b(?:fun|class|interface)\s*<([^>]*)>/g)) {
            for (const p of m[1].split(",")) {
                const n = /^\s*(?:reified\s+|in\s+|out\s+)?(\w+)/.exec(p);
                if (n) { names.add(n[1]); }
            }
        }
        return names;
    }

    // ---- declarations in source

    private parseBlock(start: number, end: number, owner: SourceClass | undefined, pkg: string, out: SourceDeclarations) {
        const t = this.text;
        let i = start;
        while (i < end) {
            const c = t[i];
            if (/\s/.test(c) || c === ";") { i++; continue; }
            DECLARATION.lastIndex = i;
            const m = /\w/.test(t[i - 1] ?? "") ? null : DECLARATION.exec(t);
            if (!m) {
                if (OPENERS[c]) {
                    const close = this.matchForward(i);
                    i = close < 0 ? end : close + 1;
                } else if (/\w/.test(c)) {
                    while (i < end && /\w/.test(t[i])) { i++; }
                } else {
                    i++;
                }
                continue;
            }
            const modifiers = m[0].slice(0, m[0].length - m[1].length);
            const visible = !/\b(?:private|protected)\b/.test(modifiers);
            const after = i + m[0].length;
            if (m[1] === "class" || m[1] === "interface" || m[1] === "object") {
                i = this.parseClass(after, m[1], modifiers, visible, owner, pkg, out);
            } else if (m[1] === "fun") {
                const [member, next] = this.parseFunction(after, modifiers, visible);
                if (member) { (owner ? owner.members : out.topLevel).push(member); }
                i = Math.max(next, after);
            } else if (m[1] === "val" || m[1] === "var") {
                const [member, next] = this.parseProperty(after, m[1] === "var", visible);
                if (member) { (owner ? owner.members : out.topLevel).push(member); }
                i = Math.max(next, after);
            } else {
                i = this.skipDeclaration(after);
            }
        }
    }

    private parseClass(after: number, keyword: string, modifiers: string, visible: boolean, owner: SourceClass | undefined, pkg: string, out: SourceDeclarations): number {
        const t = this.text;
        let i = skipSpace(t, after);
        const companion = keyword === "object" && /\bcompanion\b/.test(modifiers);
        const kind: ClassKind = keyword === "interface" ? "interface" : keyword === "object" ? (companion ? "companion" : "object")
            : /\benum\b/.test(modifiers) ? "enum" : /\bannotation\b/.test(modifiers) ? "annotation" : "class";
        const nameMatch = /^[A-Za-z_]\w*/.exec(t.slice(i, i + 200));
        let name: string;
        if (nameMatch && !["by", "where"].includes(nameMatch[0])) {
            name = nameMatch[0];
            i += name.length;
        } else if (companion) {
            name = "Companion";
        } else {
            return this.skipDeclaration(i);
        }
        const id = owner ? `${owner.id}.${name}` : pkg ? `${pkg}/${name}` : name;
        i = skipSpace(t, i);
        let typeParams: string[] = [];
        if (t[i] === "<") {
            const close = this.angleEnd(i);
            if (close < 0) { return t.length; }
            typeParams = typeParamNames(t.slice(i + 1, close));
            i = skipSpace(t, close + 1);
        }
        const ctorKeyword = /^(?:(?:public|private|protected|internal)\s+)?(?:@[\w.]+(?:\([^()]*\))?\s*)*constructor\b/.exec(t.slice(i, i + 200));
        if (ctorKeyword) { i = skipSpace(t, i + ctorKeyword[0].length); }
        const cls: SourceClass = { id, kind, typeParams, supertypes: [], members: [], data: /\bdata\b/.test(modifiers), enumEntries: [], visible };
        if (t[i] === "(") {
            const close = this.matchForward(i);
            if (close < 0) { return t.length; }
            const params = this.parseParams(i, close);
            cls.primaryConstructor = params.map(p => p.param);
            for (const p of params) {
                if (p.property) {
                    cls.members.push({ kind: "property", name: p.param.name, at: p.at, typeParams: [], params: [], type: p.param.type, blockBody: false, isVar: p.isVar, suspend: false, visible: p.visible });
                }
            }
            i = skipSpace(t, close + 1, true);
        }
        if (t[i] === ":" && t[i + 1] !== ":") {
            let start = i + 1;
            let depth = 0;
            let j = start;
            const push = (from: number, to: number) => {
                let e = to;
                let d = 0;
                for (let k = from; k < to; k++) {
                    if (t[k] === "<") { d++; } else if (t[k] === ">" && t[k - 1] !== "-") { d--; }
                    if (d === 0 && (t[k] === "(" || t.startsWith(" by ", k))) { e = k; break; }
                }
                if (/\S/.test(t.slice(from, e))) { cls.supertypes.push([skipSpace(t, from), e]); }
            };
            for (; j < t.length; j++) {
                const ch = t[j];
                if (ch === "(" || (ch === "<")) { depth++; }
                else if (ch === ")" || (ch === ">" && t[j - 1] !== "-")) { depth--; }
                else if (depth === 0 && (ch === "{" || ch === "}" || ch === ";" || /^where\b/.test(t.slice(j, j + 6)))) { break; }
                else if (depth === 0 && ch === "\n" && !/[,:]\s*$/.test(t.slice(start, j)) && !/^\s*[,{:]/.test(t.slice(j + 1, j + 80))) { break; }
                else if (depth === 0 && ch === ",") {
                    push(start, j);
                    start = j + 1;
                }
            }
            push(start, j);
            i = j;
        }
        i = skipSpace(t, i);
        if (t.startsWith("where", i)) {
            while (i < t.length && t[i] !== "{" && t[i] !== "\n") { i++; }
            i = skipSpace(t, i);
        }
        out.classes.push(cls);
        if (owner && companion) { owner.companion = id; }
        if (t[i] !== "{") { return i; }
        const close = this.matchForward(i);
        const bodyEnd = close < 0 ? t.length : close;
        let bodyStart = i + 1;
        if (kind === "enum") {
            let depth = 0;
            let j = bodyStart;
            for (; j < bodyEnd; j++) {
                if (OPENERS[t[j]]) { depth++; } else if (CLOSERS[t[j]]) { depth--; } else if (depth === 0 && t[j] === ";") { break; }
            }
            const entries = t.slice(bodyStart, j);
            if (!/\b(?:fun|val|var)\b/.test(entries.replace(/\{[^{}]*\}/g, ""))) {
                cls.enumEntries = splitArgs(t, { open: "{", start: bodyStart - 1, end: j })
                    .map(r => /^\s*(?:@[\w.]+\s*)*([A-Za-z_]\w*)/.exec(t.slice(r.start, r.end))?.[1])
                    .filter((n): n is string => !!n);
                bodyStart = j;
            }
        }
        this.parseBlock(bodyStart, bodyEnd, cls, pkg, out);
        return bodyEnd + 1;
    }

    private parseParams(open: number, close: number): Array<{ param: SourceParam; at: number; property: boolean; isVar: boolean; visible: boolean }> {
        const t = this.text;
        const out: Array<{ param: SourceParam; at: number; property: boolean; isVar: boolean; visible: boolean }> = [];
        for (const r of splitArgs(t, { open: "(", start: open, end: close })) {
            const m = /^\s*(?:@[\w.:]+(?:\s*\([^()]*\))?\s*)*((?:(?:public|private|protected|internal|override|open|final|vararg|noinline|crossinline)\s+)*)(?:(val|var)\s+)?([A-Za-z_]\w*)\s*:(?!:)/.exec(t.slice(r.start, r.end));
            if (!m) { continue; }
            const [typeStart, typeEnd] = this.typeExtent(r.start + m[0].length);
            const hasDefault = t[skipSpace(t, typeEnd)] === "=";
            out.push({
                param: { name: m[3], type: [typeStart, typeEnd], vararg: /\bvararg\b/.test(m[1]), hasDefault },
                at: r.start, property: !!m[2], isVar: m[2] === "var", visible: !/\b(?:private|protected)\b/.test(m[1]),
            });
        }
        return out;
    }

    /** `fun <T> Receiver.name(params): Type = expr` / `{ ... }` */
    private parseFunction(after: number, modifiers: string, visible: boolean): [SourceMember | undefined, number] {
        const t = this.text;
        let i = skipSpace(t, after);
        let typeParams: string[] = [];
        if (t[i] === "<") {
            const close = this.angleEnd(i);
            if (close < 0) { return [undefined, t.length]; }
            typeParams = typeParamNames(t.slice(i + 1, close));
            i = skipSpace(t, close + 1);
        }
        let open = -1;
        for (let j = i, depth = 0; j < t.length && j < i + 400; j++) {
            if (t[j] === "<") { depth++; } else if (t[j] === ">" && t[j - 1] !== "-") { depth--; }
            else if (depth === 0 && t[j] === "(") { open = j; break; }
            else if (depth === 0 && /[{=\n;]/.test(t[j])) { break; }
        }
        if (open < 0) { return [undefined, this.skipDeclaration(i)]; }
        const [receiver, name] = this.receiverAndName(i, open);
        const close = this.matchForward(open);
        if (close < 0 || !name) { return [undefined, t.length]; }
        const params = this.parseParams(open, close).map(p => p.param);
        let j = skipSpace(t, close + 1, true);
        let type: Range | undefined;
        if (t[j] === ":") {
            type = this.typeExtent(j + 1);
            j = skipSpace(t, type[1]);
        }
        if (t.startsWith("where", j)) {
            while (j < t.length && t[j] !== "{" && t[j] !== "=") { j++; }
        }
        j = skipSpace(t, j);
        let body: Range | undefined;
        let blockBody = false;
        let next = j;
        if (t[j] === "=" && t[j + 1] !== "=") {
            const end = this.statementEnd(j + 1);
            body = [j + 1, end];
            next = end;
        } else if (t[j] === "{") {
            const end = this.matchForward(j);
            blockBody = true;
            next = end < 0 ? t.length : end + 1;
        }
        return [{ kind: "function", name, at: after, typeParams, receiver, params, type, body, blockBody, isVar: false, suspend: /\bsuspend\b/.test(modifiers), visible }, next];
    }

    /** `val <T> Receiver.name: Type = expr` / `by lazy { }` */
    private parseProperty(after: number, isVar: boolean, visible: boolean): [SourceMember | undefined, number] {
        const t = this.text;
        let i = skipSpace(t, after);
        let typeParams: string[] = [];
        if (t[i] === "<") {
            const close = this.angleEnd(i);
            if (close < 0) { return [undefined, t.length]; }
            typeParams = typeParamNames(t.slice(i + 1, close));
            i = skipSpace(t, close + 1);
        }
        if (t[i] === "(") { return [undefined, this.statementEnd(i)]; }
        let j = i;
        for (let depth = 0; j < t.length && j < i + 400; j++) {
            if (t[j] === "<") { depth++; } else if (t[j] === ">" && t[j - 1] !== "-") { depth--; }
            else if (depth === 0 && ((t[j] === ":" && t[j + 1] !== ":") || t[j] === "=" || /[\n;{}]/.test(t[j]) || t.startsWith(" by ", j)
                || /^\s(?:get|set)\s*\(/.test(t.slice(j, j + 8)))) { break; }
        }
        const [receiver, name] = this.receiverAndName(i, j);
        if (!name) { return [undefined, this.statementEnd(i)]; }
        let type: Range | undefined;
        if (t[j] === ":") {
            type = this.typeExtent(j + 1);
            j = skipSpace(t, type[1], true);
        }
        let body: Range | undefined;
        let lazy: number | undefined;
        let next = j;
        // `val x get() = expr` / `val x: T\n    get() = expr`
        const getter = /^\s*get\s*\(\s*\)\s*=(?!=)/.exec(t.slice(j, j + 200));
        if (getter && !type) {
            const start = j + getter[0].length;
            const end = this.statementEnd(start);
            return [{ kind: "property", name, at: after, typeParams, receiver, params: [], body: [start, end], blockBody: false, isVar, suspend: false, visible }, end];
        }
        if (t[j] === "=" && t[j + 1] !== "=") {
            const end = this.statementEnd(j + 1);
            body = [j + 1, end];
            next = end;
        } else {
            const by = /^\s*by\s+(lazy\s*(?:\([^)]*\)\s*)?\{)?/.exec(t.slice(j, j + 80));
            if (by) {
                if (by[1]) { lazy = j + by[0].length - 1; }
                next = this.statementEnd(j + by[0].length - (by[1] ? 1 : 0));
            }
        }
        return [{ kind: "property", name, at: after, typeParams, receiver, params: [], type, body, lazy, blockBody: false, isVar, suspend: false, visible }, next];
    }

    /** `List<T>.name` → receiver range and `name`. */
    private receiverAndName(start: number, end: number): [Range | undefined, string | undefined] {
        const t = this.text;
        let dot = -1;
        for (let k = start, depth = 0; k < end; k++) {
            if (t[k] === "<" || t[k] === "(") { depth++; } else if ((t[k] === ">" && t[k - 1] !== "-") || t[k] === ")") { depth--; }
            else if (depth === 0 && t[k] === ".") { dot = k; }
        }
        const name = /^\s*`?([A-Za-z_]\w*)`?\s*$/.exec(t.slice(dot < 0 ? start : dot + 1, end))?.[1];
        return [dot < 0 ? undefined : [skipSpace(t, start), dot], name];
    }

    /** End of `init { }`, `constructor(...) { }`, `typealias X = Y`. */
    private skipDeclaration(from: number): number {
        const t = this.text;
        let i = skipSpace(t, from);
        while (t[i] === "(") {
            const close = this.matchForward(i);
            if (close < 0) { return t.length; }
            i = skipSpace(t, close + 1);
        }
        if (t[i] === "{") {
            const close = this.matchForward(i);
            return close < 0 ? t.length : close + 1;
        }
        return Math.max(this.statementEnd(i), from + 1);
    }

    private angleEnd(open: number): number {
        const t = this.text;
        let depth = 0;
        for (let i = open; i < t.length && i < open + 500; i++) {
            if (t[i] === "<") { depth++; }
            else if (t[i] === ">" && t[i - 1] !== "-" && --depth === 0) { return i; }
        }
        return -1;
    }

    // ---- text structure

    private tokenize(start: number, end: number): Token[] {
        const t = this.text;
        const tokens: Token[] = [];
        let i = start;
        while (i < end) {
            const c = t[i];
            if (/\s/.test(c)) { i++; continue; }
            if (/[A-Za-z_]/.test(c)) {
                const m = /^[A-Za-z_]\w*/.exec(t.slice(i, Math.min(end, i + 200)))!;
                tokens.push({ t: "id", v: m[0], at: i });
                i += m[0].length;
                continue;
            }
            if (c === "`") {
                const close = t.indexOf("`", i + 1);
                if (close < 0 || close >= end) { break; }
                tokens.push({ t: "id", v: t.slice(i + 1, close), at: i });
                i = close + 1;
                continue;
            }
            if (/[0-9]/.test(c)) {
                const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[fFdDlLuU]*/.exec(t.slice(i, end))!;
                tokens.push({ t: "num", v: m[0], at: i });
                i += m[0].length;
                continue;
            }
            if (c === "\"") {
                const close = this.stringEnd(i);
                tokens.push({ t: "str", at: i });
                i = close;
                continue;
            }
            if (c === "'") {
                const close = t.indexOf("'", i + 1);
                tokens.push({ t: "char", at: i });
                i = close < 0 ? end : close + 1;
                continue;
            }
            if (OPENERS[c]) {
                const close = this.matchForward(i);
                if (close < 0 || close >= end) { tokens.push({ t: "op", v: c, at: i }); i++; continue; }
                tokens.push({ t: "group", g: { open: c, start: i, end: close }, at: i });
                i = close + 1;
                continue;
            }
            if (c === "<" && tokens[tokens.length - 1]?.t === "id") {
                const close = this.typeArgsEnd(i);
                if (close > 0 && close < end) {
                    tokens.push({ t: "group", g: { open: "<", start: i, end: close }, at: i });
                    i = close + 1;
                    continue;
                }
            }
            const op = ["..<", "===", "!==", "?.", "!!", "::", "?:", "->", "..", "==", "!=", "<=", ">=", "&&", "||", "++", "--"].find(o => t.startsWith(o, i)) ?? c;
            tokens.push({ t: "op", v: op, at: i });
            i += op.length;
        }
        return tokens;
    }

    /** `<String, List<Int>>` followed by `(`, `{` or `::`; returns the index of `>` or -1. */
    private typeArgsEnd(open: number): number {
        const t = this.text;
        let depth = 0;
        for (let i = open; i < t.length && i < open + 300; i++) {
            const c = t[i];
            if (c === "<") { depth++; }
            else if (c === ">" && t[i - 1] !== "-") {
                if (--depth === 0) {
                    const next = skipSpace(t, i + 1, true);
                    return t[next] === "(" || t[next] === "{" || t.startsWith("::", next) ? i : -1;
                }
            } else if (!/[\w\s.,?*()\->:@]/.test(c)) { return -1; }
        }
        return -1;
    }

    private stringEnd(open: number): number {
        const t = this.text;
        const raw = t.startsWith("\"\"\"", open);
        for (let i = open + (raw ? 3 : 1); i < t.length; i++) {
            if (t[i] === "$" && t[i + 1] === "{") {
                const close = this.matchForward(i + 1);
                if (close < 0) { return t.length; }
                i = close;
            } else if (raw ? t.startsWith("\"\"\"", i) : t[i] === "\"") {
                return i + (raw ? 3 : 1);
            } else if (!raw && t[i] === "\n") {
                return i;
            }
        }
        return t.length;
    }

    /** Index of the bracket matching the opener at `open`, or -1. */
    private matchForward(open: number): number {
        const t = this.text;
        const stack: string[] = [];
        for (let i = open; i < t.length; i++) {
            const c = t[i];
            if (c === "\"") { i = this.stringEnd(i) - 1; continue; }
            if (OPENERS[c]) { stack.push(c); continue; }
            if (CLOSERS[c]) {
                if (stack.pop() !== CLOSERS[c]) { return -1; }
                if (!stack.length) { return i; }
            }
        }
        return -1;
    }

    private matchBackward(close: number): number {
        const t = this.text;
        let depth = 0;
        for (let i = close; i >= 0; i--) {
            if (CLOSERS[t[i]]) { depth++; }
            else if (OPENERS[t[i]] && --depth === 0) { return i; }
        }
        return -1;
    }

    private matchAngleBackward(close: number): number {
        const t = this.text;
        let depth = 0;
        for (let i = close; i >= 0 && i > close - 300; i--) {
            if (t[i] === ">" && t[i - 1] !== "-") { depth++; }
            else if (t[i] === "<" && --depth === 0) { return i; }
        }
        return -1;
    }

    /** Innermost unclosed `kind` bracket before `at`. */
    private enclosingOpen(at: number, kind: string): number {
        const t = this.text;
        let depth = 0;
        for (let i = at; i >= 0; i--) {
            if (CLOSERS[t[i]]) { depth++; }
            else if (OPENERS[t[i]]) {
                if (depth === 0) { return t[i] === kind ? i : this.enclosingOpen(i - 1, kind); }
                depth--;
            }
        }
        return -1;
    }

    /** Unclosed `{` around `at`, innermost first. */
    private enclosingBraces(at: number): number[] {
        const t = this.text;
        const braces: number[] = [];
        let depth = 0;
        for (let i = at - 1; i >= 0; i--) {
            if (t[i] === "}") { depth++; }
            else if (t[i] === "{") {
                if (depth === 0) { braces.push(i); } else { depth--; }
            }
        }
        return braces;
    }

    private enclosingLambda(at: number, implicitIt: boolean): number {
        for (const brace of this.enclosingBraces(at)) {
            if (this.classOfBody(brace)) { return -1; }
            const close = this.matchForward(brace);
            if (implicitIt && this.lambdaArrow(brace, close < 0 ? this.text.length : close) >= 0) { continue; }
            if (this.isLambda(brace)) { return brace; }
        }
        return -1;
    }

    /** A `{` that starts a lambda rather than a class/function/control-flow body. */
    private isLambda(brace: number): boolean {
        const t = this.text;
        const p = skipSpaceBack(t, brace - 1, true);
        if (t[p] === ")") {
            const open = this.matchBackward(p);
            const head = t.slice(Math.max(0, open - 60), open);
            return !/\b(?:fun\s+[\w.<>?, ]*|if|while|for|when|catch|init|constructor|get|set)\s*$/.test(head);
        }
        if (/[\w>?]/.test(t[p] ?? "")) {
            // `fun f(): Type {` is a function body
            if (/\bfun\b[^{};=]*\)\s*:\s*[\w.<>?, ()\->]+$/.test(t.slice(Math.max(0, brace - 300), brace))) { return false; }
            const word = /\w*$/.exec(t.slice(Math.max(0, p - 40), p + 1))![0];
            return !["else", "try", "finally", "do", "init", "get", "set", "when", ""].includes(word) && !this.classOfBody(brace);
        }
        return t[p] === "(" || t[p] === "," || t[p] === "=";
    }

    /** `->` of a lambda's parameter list, or -1. */
    private lambdaArrow(brace: number, close: number): number {
        const m = /^\s*(?:\(?[\w\s,:<>?.()]*?\)?)\s*->/.exec(this.text.slice(brace + 1, Math.min(close, brace + 200)));
        return m ? brace + 1 + m[0].length - 2 : -1;
    }

    /** The class id when `{` at `brace` is the body of `class`/`object`/`interface` (nested classes joined by `.`). */
    private classOfBody(brace: number): string | undefined {
        const head = this.text.slice(Math.max(0, brace - 1500), brace);
        const m = /\b(?:class|interface|object)\s+([A-Za-z_]\w*)([^{};]*)$/.exec(head) ?? /\b(companion)\s+object\s*()$/.exec(head);
        if (!m) { return undefined; }
        // `class A(val x: Int)` without a body, followed by `fun f() {`: the header must not contain declarations.
        let rest = m[2];
        for (let i = 0; i < 10 && /\([^()]*\)/.test(rest); i++) { rest = rest.replace(/\([^()]*\)/g, ""); }
        if (/\b(?:fun|val|var|return|if|when|for|while|init)\b|=/.test(rest)) { return undefined; }
        const name = m[1] === "companion" ? "Companion" : m[1];
        const outer = this.enclosingBraces(brace).map(b => this.classOfBody(b)).find(Boolean);
        if (outer) { return `${outer}.${name}`; }
        const pkg = this.file.packageName.replace(/\./g, "/");
        return pkg ? `${pkg}/${name}` : name;
    }

    /** End of the block that contains `at`. */
    private blockEnd(at: number): number {
        const brace = this.enclosingBraces(at)[0];
        if (brace === undefined) { return this.text.length; }
        const close = this.matchForward(brace);
        return close < 0 ? this.text.length : close;
    }

    /** Parameters at `listItem` (inside `(...)` or a lambda's `{ a: T ->`): visible in the body that follows. */
    private parameterScopeEnd(listItem: number): number {
        const t = this.text;
        if (t[listItem] === "{") {
            const close = this.matchForward(listItem);
            return close < 0 ? t.length : close;
        }
        const open = t[listItem] === "(" ? listItem : this.enclosingOpen(listItem, "(");
        const close = open >= 0 ? this.matchForward(open) : -1;
        return close < 0 ? t.length : this.bodyEnd(close + 1);
    }

    /** The body after a header ending at `from`: `{ ... }`, `= expr`, or a single statement. */
    private bodyEnd(from: number): number {
        const t = this.text;
        let depth = 0;
        for (let i = from; i < t.length; i++) {
            const c = t[i];
            if (c === "(" || c === "<") { depth++; }
            else if (c === ")" || (c === ">" && t[i - 1] !== "-")) { depth--; }
            else if (depth <= 0 && c === "{") {
                const close = this.matchForward(i);
                return close < 0 ? t.length : close;
            } else if (depth <= 0 && c === "=" && t[i + 1] !== "=") {
                return this.statementEnd(i + 1);
            } else if (depth <= 0 && (c === "}" || c === ";")) {
                return i;
            } else if (depth <= 0 && c === "\n" && !/^\s*[:.{=]/.test(t.slice(i + 1, i + 40)) && !/[:,(=]\s*$/.test(t.slice(from, i))) {
                return this.statementEnd(i + 1);
            }
        }
        return t.length;
    }

    /** Where the expression containing `end` starts (after `=`, `,`, `(`, `return`, a statement break, ...). */
    private regionStart(end: number): number {
        const t = this.text;
        let depth = 0;
        for (let i = end - 1; i >= 0; i--) {
            const c = t[i];
            if (CLOSERS[c]) { depth++; continue; }
            if (OPENERS[c]) {
                if (depth === 0) { return i + 1; }
                depth--;
                continue;
            }
            if (depth > 0) { continue; }
            if (c === ";" || c === ",") { return i + 1; }
            if (c === "=" && !"=!<>".includes(t[i - 1]) && t[i + 1] !== "=") { return i + 1; }
            if (c === "\n") {
                const next = skipSpace(t, i + 1);
                if (!(t[next] === "." || (t[next] === "?" && t[next + 1] === "."))) { return i + 1; }
            }
        }
        return 0;
    }

    /** End of the statement starting at `start` (chains may continue on lines starting with `.`). */
    private statementEnd(start: number): number {
        const t = this.text;
        let depth = 0;
        for (let i = start; i < t.length; i++) {
            const c = t[i];
            if (c === "\"") { i = this.stringEnd(i) - 1; continue; }
            if (OPENERS[c]) { depth++; continue; }
            if (CLOSERS[c]) {
                if (depth === 0) { return i; }
                depth--;
                continue;
            }
            if (depth === 0 && c === ";") { return i; }
            if (depth === 0 && c === "\n") {
                const next = skipSpace(t, i + 1);
                const continued = t[next] === "." || t.startsWith("?.", next) || t.startsWith("?:", next);
                if (!continued && /\S/.test(t.slice(start, i))) { return i; }
            }
        }
        return t.length;
    }

    /** Start of the last statement in `[from, to)` (a lambda body). */
    private lastStatementStart(from: number, to: number): number {
        const t = this.text;
        let depth = 0;
        for (let i = to - 1; i >= from; i--) {
            const c = t[i];
            if (CLOSERS[c]) { depth++; continue; }
            if (OPENERS[c]) { depth--; continue; }
            if (depth !== 0) { continue; }
            if (c === ";") { return i + 1; }
            if (c === "\n") {
                const next = skipSpace(t, i + 1);
                const continued = next < to && (t[next] === "." || t.startsWith("?.", next) || t.startsWith("?:", next));
                if (!continued && /\S/.test(t.slice(i + 1, to))) { return i + 1; }
            }
        }
        return from;
    }

    /** The extent of a type starting at `from`: `Map<K, List<V>>?`, `(A) -> B`, `suspend T.() -> Unit`. */
    private typeExtent(from: number): [number, number] {
        const t = this.text;
        const start = skipSpace(t, from, true);
        let depth = 0;
        let i = start;
        for (; i < t.length; i++) {
            const c = t[i];
            if (c === "<" || c === "(") { depth++; }
            else if (c === ">" && t[i - 1] !== "-") { depth--; }
            else if (c === ")") {
                if (depth === 0) { break; }
                depth--;
            } else if (depth === 0 && /[,={};\n]/.test(c)) {
                break;
            } else if (depth === 0 && (t.startsWith(" by ", i) || /^\s(?:get|set)\s*\(/.test(t.slice(i, i + 8)))) {
                break;
            }
        }
        let e = i;
        while (e > start && /\s/.test(t[e - 1])) { e--; }
        return [start, e];
    }
}

// ---------------------------------------------------------------------------------------------

/** Comments and string contents become spaces (offsets are kept); `${...}` templates stay code. */
export function mask(text: string): string {
    const out = text.split("");
    const blank = (from: number, to: number) => {
        for (let k = from; k < to && k < out.length; k++) { if (out[k] !== "\n") { out[k] = " "; } }
    };
    const string = (start: number): number => {
        const raw = text.startsWith("\"\"\"", start);
        let k = start + (raw ? 3 : 1);
        while (k < text.length) {
            if (raw ? text.startsWith("\"\"\"", k) : text[k] === "\"") {
                if (raw) {
                    while (text[k + 3] === "\"") { blank(k, k + 1); k++; }
                    return k + 3;
                }
                return k + 1;
            }
            if (!raw && text[k] === "\\") { blank(k, k + 2); k += 2; continue; }
            if (!raw && text[k] === "\n") { return k; }
            if (text[k] === "$" && text[k + 1] === "{") { k = code(k + 2, true) + 1; continue; }
            blank(k, k + 1);
            k++;
        }
        return k;
    };
    const code = (k: number, untilBrace: boolean): number => {
        let depth = 0;
        while (k < text.length) {
            const c = text[k];
            if (c === "/" && text[k + 1] === "/") {
                const e = text.indexOf("\n", k);
                const stop = e < 0 ? text.length : e;
                blank(k, stop);
                k = stop;
            } else if (c === "/" && text[k + 1] === "*") {
                const e = text.indexOf("*/", k + 2);
                const stop = e < 0 ? text.length : e + 2;
                blank(k, stop);
                k = stop;
            } else if (c === "\"") {
                k = string(k);
            } else if (c === "'") {
                const m = /^'(?:\\u[0-9a-fA-F]{4}|\\.|[^'\\\n])'/.exec(text.slice(k, k + 8));
                if (m) { blank(k + 1, k + m[0].length - 1); k += m[0].length; } else { k++; }
            } else {
                if (untilBrace && c === "{") { depth++; }
                if (untilBrace && c === "}") {
                    if (depth === 0) { return k; }
                    depth--;
                }
                k++;
            }
        }
        return k;
    };
    code(0, false);
    return out.join("");
}

function typeParamNames(list: string): string[] {
    return list.split(",").map(p => /^\s*(?:reified\s+|in\s+|out\s+)*(\w+)/.exec(p)?.[1]).filter((n): n is string => !!n);
}

function skipSpace(t: string, i: number, sameLine = false): number {
    while (i < t.length && (sameLine ? t[i] === " " || t[i] === "\t" : /\s/.test(t[i]))) { i++; }
    return i;
}

function skipSpaceBack(t: string, i: number, sameLine = false): number {
    while (i >= 0 && (sameLine ? t[i] === " " || t[i] === "\t" : /\s/.test(t[i]))) { i--; }
    return i;
}

/** Top-level comma-separated arguments of a group; `name = value` named arguments are recognized. */
function splitArgs(t: string, g: Group): Array<{ start: number; end: number; name?: string }> {
    const out: Array<{ start: number; end: number; name?: string }> = [];
    let depth = 0;
    let start = g.start + 1;
    const push = (end: number) => {
        if (!/\S/.test(t.slice(start, end))) { return; }
        const named = /^\s*(\w+)\s*=(?!=)/.exec(t.slice(start, end));
        out.push(named ? { start: start + named[0].length, end, name: named[1] } : { start, end });
    };
    for (let i = g.start + 1; i < g.end; i++) {
        const c = t[i];
        if (OPENERS[c] || (c === "<" && /\w/.test(t[i - 1] ?? ""))) { depth++; }
        else if (CLOSERS[c] || (c === ">" && depth > 0 && t[i - 1] !== "-")) { depth--; }
        else if (c === "," && depth === 0) {
            push(i);
            start = i + 1;
        }
    }
    push(g.end);
    return out;
}

/** Start index of the postfix chain at the end of `tokens` (`a.b(c)[0]!!`). */
function chainStart(tokens: Token[]): number | undefined {
    let i = tokens.length - 1;
    if (i < 0) { return undefined; }
    for (;;) {
        let groups = 0;
        while (i >= 0 && (tokens[i].t === "group" || isOp(tokens[i], "!!"))) {
            if (tokens[i].t === "group") { groups++; }
            i--;
        }
        const tok = tokens[i];
        if (tok?.t === "id" && !STOP_KEYWORDS.has(tok.v)) {
            i--;
        } else if (tok && (tok.t === "str" || tok.t === "num" || tok.t === "char") && !groups) {
            return i;
        } else {
            return i + 1 < tokens.length ? i + 1 : undefined;
        }
        if (i >= 0 && (isOp(tokens[i], ".") || isOp(tokens[i], "?."))) {
            i--;
            continue;
        }
        return i + 1;
    }
}

function isOp(t: Token | undefined, v: string): boolean {
    return t?.t === "op" && t.v === v;
}

function parseChain(tokens: Token[]): Chain | undefined {
    let i = 0;
    const group = (open: string): Group | undefined => {
        const tok = tokens[i];
        return tok?.t === "group" && tok.g.open === open ? tok.g : undefined;
    };
    const call = (): Call | undefined => {
        const c: Call = {};
        if (group("<")) { c.typeArgs = group("<"); i++; }
        if (group("(")) { c.args = group("("); i++; }
        if (group("{")) { c.lambda = group("{"); i++; }
        return c.args || c.lambda ? c : undefined;
    };
    const first = tokens[i++];
    let atom: Atom;
    if (!first) { return undefined; }
    if (first.t === "id") {
        atom = first.v === "this" || first.v === "super" ? { kind: "this", at: first.at } : { kind: "name", name: first.v, at: first.at, call: call() };
    } else if (first.t === "str") {
        atom = { kind: "literal", type: classType("kotlin/String") };
    } else if (first.t === "char") {
        atom = { kind: "literal", type: classType("kotlin/Char") };
    } else if (first.t === "num") {
        atom = { kind: "literal", type: numberType(first.v) };
    } else if (first.t === "group" && first.g.open === "(") {
        atom = { kind: "paren", g: first.g };
    } else {
        return undefined;
    }
    const selectors: Selector[] = [];
    while (i < tokens.length) {
        const tok = tokens[i];
        if (isOp(tok, ".") || isOp(tok, "?.")) {
            const name = tokens[i + 1];
            if (name?.t !== "id") { return undefined; }
            i += 2;
            selectors.push({ kind: "member", name: name.v, at: name.at, call: call() });
        } else if (tok.t === "group" && tok.g.open === "[") {
            selectors.push({ kind: "index", g: tok.g });
            i++;
        } else if (isOp(tok, "!!")) {
            selectors.push({ kind: "notNull" });
            i++;
        } else {
            return undefined;
        }
    }
    return { atom, selectors };
}

function numberType(literal: string): KType {
    if (/[lL]$/.test(literal)) { return classType("kotlin/Long"); }
    if (/[fF]$/.test(literal)) { return classType("kotlin/Float"); }
    if (/[uU]/.test(literal)) { return classType("kotlin/UInt"); }
    if (/^\d[\d_]*(?:\.\d|[eE])/.test(literal) || /[dD]$/.test(literal)) { return classType("kotlin/Double"); }
    return classType("kotlin/Int");
}

function mentions(t: KType, params: Set<string>): boolean {
    return t.param ? params.has(t.param) : t.args.some(a => !!a.type && mentions(a.type, params));
}

/** The overload that accepts `count` arguments (defaults and varargs considered); members come first. */
function pickOverload<M extends Member>(fns: M[], count: number, trailingLambda: boolean): M | undefined {
    const accepts = (f: M) => {
        const required = f.params.filter(p => !p.hasDefault && !p.vararg).length;
        const lambdaOk = !trailingLambda || isFunctionType(f.params[f.params.length - 1]?.type);
        return lambdaOk && count >= required && (count <= f.params.length || f.params.some(p => p.vararg));
    };
    return fns.find(f => f.params.length === count && accepts(f)) ?? fns.find(accepts);
}

/** Parses a Kotlin type written in source. `resolve` maps (qualified) names to class or parameter types. */
class TypeParser {
    private i = 0;

    constructor(private readonly s: string, private readonly resolve: (segments: string[]) => KType | undefined) {}

    type(): KType | undefined {
        this.space();
        while (this.s[this.i] === "@") {
            this.i++;
            this.name();
            if (this.s[this.i] === "(") { this.skipGroup("(", ")"); }
            this.space();
        }
        let suspend = false;
        if (/^suspend\b/.test(this.s.slice(this.i))) {
            suspend = true;
            this.i += 7;
            this.space();
        }
        let t: KType | undefined;
        if (this.s[this.i] === "(") {
            const params = this.list();
            this.space();
            if (this.s.startsWith("->", this.i)) {
                this.i += 2;
                t = functionType(params, this.type(), suspend, false);
            } else {
                t = params[0];
            }
        } else {
            const segments = this.name();
            if (!segments.length) { return undefined; }
            this.space();
            const args = this.s[this.i] === "<" ? this.args() : [];
            const resolved = this.resolve(segments) ?? { param: segments.join("."), args: [], nullable: false };
            t = args.length ? { ...resolved, args } : resolved;
            this.space();
            if (this.s[this.i] === "." && this.s[this.i + 1] === "(") {
                this.i++;
                const params = this.list();
                this.space();
                if (this.s.startsWith("->", this.i)) {
                    this.i += 2;
                    t = functionType([t, ...params], this.type(), suspend, true);
                }
            }
        }
        this.space();
        if (this.s[this.i] === "?") {
            this.i++;
            t = t && { ...t, nullable: true };
        }
        return t;
    }

    private space() { while (/\s/.test(this.s[this.i] ?? "")) { this.i++; } }

    private name(): string[] {
        const segments: string[] = [];
        for (;;) {
            const m = /^[A-Za-z_]\w*/.exec(this.s.slice(this.i));
            if (!m) { break; }
            segments.push(m[0]);
            this.i += m[0].length;
            if (this.s[this.i] === "." && /[A-Za-z_]/.test(this.s[this.i + 1] ?? "")) { this.i++; } else { break; }
        }
        return segments;
    }

    private args(): KArg[] {
        const args: KArg[] = [];
        this.i++;
        while (this.i < this.s.length && this.s[this.i] !== ">") {
            this.space();
            if (this.s[this.i] === "*") {
                this.i++;
                args.push({ variance: "*" });
            } else {
                const variance = /^(in|out)\s/.exec(this.s.slice(this.i));
                if (variance) { this.i += variance[0].length; }
                args.push({ variance: (variance?.[1] ?? "") as "" | "in" | "out", type: this.type() ?? ANY });
            }
            this.space();
            if (this.s[this.i] === ",") { this.i++; } else if (this.s[this.i] !== ">") { break; }
        }
        this.i++;
        return args;
    }

    /** `(A, name: B)` → `[A, B]` */
    private list(): KType[] {
        const types: KType[] = [];
        this.i++;
        while (this.i < this.s.length && this.s[this.i] !== ")") {
            this.space();
            const named = /^\w+\s*:(?!:)/.exec(this.s.slice(this.i));
            if (named) { this.i += named[0].length; }
            const t = this.type();
            if (t) { types.push(t); }
            this.space();
            if (this.s[this.i] === ",") { this.i++; } else if (this.s[this.i] !== ")") { break; }
        }
        this.i++;
        return types;
    }

    private skipGroup(open: string, close: string) {
        let depth = 0;
        for (; this.i < this.s.length; this.i++) {
            if (this.s[this.i] === open) { depth++; }
            if (this.s[this.i] === close && --depth === 0) { this.i++; return; }
        }
    }
}

function functionType(params: KType[], result: KType | undefined, suspend: boolean, extension: boolean): KType {
    return {
        id: `kotlin/Function${params.length}`,
        args: [...params, result ?? classType("kotlin/Unit")].map((type): KArg => ({ variance: "", type })),
        nullable: false,
        suspend: suspend || undefined,
        extensionFunction: extension || undefined,
    };
}

// ---------------------------------------------------------------------------------------------
// Completion entries for `value.`

/** `ClassName.` for classes known only from source (not compiled yet): enum entries, companion/object members. */
export function staticEntries(id: string, types: TypeSystem): Entry[] {
    return types.staticMembers(id).map(m => entry({ ...m, inherited: false }));
}

/** Members of `type`, then the extensions that are not shadowed by a member (a member always wins in Kotlin). */
export function memberEntries(type: KType, types: TypeSystem, file: FileContext): Entry[] {
    const members = types.members(type);
    const keys = new Set(members.map(memberKey));
    return [...members, ...types.extensions(type, file).filter(e => !keys.has(memberKey(e)))].map(entry);
}

function entry(m: FoundMember): Entry {
    const last = m.params[m.params.length - 1];
    const lambda = m.kind === "function" && !!last && isFunctionType(last.type) && !last.vararg
        && m.params.slice(0, -1).every(p => p.hasDefault);
    // Members (declared or inherited, alphabetically), extensions, not-imported extensions, then equals/hashCode/toString.
    const group = m.owner === "kotlin/Any" ? 4 : m.extension ? (m.importName ? 3 : 2) : 0;
    return {
        kind: m.kind === "function" ? "method" : "property",
        name: m.name,
        owner: m.extension ? undefined : classIdToBinary(m.owner),
        params: m.kind === "function" ? m.params.map(p => ({ name: p.name || undefined, type: renderType(p.type), hasDefault: p.hasDefault })) : undefined,
        vararg: !!last?.vararg,
        typeParams: m.typeParams.map(p => p.name),
        type: renderType(m.returnType),
        suspend: m.suspend,
        deprecated: m.deprecated,
        inherited: m.inherited,
        importName: m.importName,
        receiver: m.receiver && renderType(m.receiver),
        pkg: m.extension ? m.owner.replace(/\//g, ".") : undefined,
        isVar: m.isVar,
        lambda,
        group,
    };
}
