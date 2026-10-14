export const ACC_PUBLIC = 0x0001;
export const ACC_STATIC = 0x0008;
export const ACC_FINAL = 0x0010;
export const ACC_BRIDGE = 0x0040;
export const ACC_VARARGS = 0x0080;
export const ACC_INTERFACE = 0x0200;
export const ACC_ABSTRACT = 0x0400;
export const ACC_SYNTHETIC = 0x1000;
export const ACC_ANNOTATION = 0x2000;
export const ACC_ENUM = 0x4000;

/** A type from a descriptor or generic signature. Class names are binary names (`java/util/Map$Entry`). */
export type JavaType =
    | { kind: "class"; name: string; args: JavaTypeArg[] }
    | { kind: "var"; name: string }
    | { kind: "array"; element: JavaType }
    | { kind: "primitive"; code: string };

export interface JavaTypeArg { variance: "" | "in" | "out" | "*"; type?: JavaType }

export interface Param { name?: string; type: string; java: JavaType }

export interface FieldInfo {
    access: number;
    name: string;
    descriptor: string;
    /** Kotlin-style type, e.g. `List<String>`. */
    type: string;
    java: JavaType;
    constant?: string;
    deprecated: boolean;
    hidden: boolean;
}

export interface MethodInfo {
    access: number;
    name: string;
    descriptor: string;
    typeParams: string[];
    params: Param[];
    returnType: string;
    returnJava: JavaType;
    suspend: boolean;
    deprecated: boolean;
    /** `@Deprecated(level = HIDDEN)`: not callable from Kotlin source. */
    hidden: boolean;
}

export interface InnerClassInfo { name: string; outer?: string; simpleName?: string; access: number }

export interface KotlinMetadataAnnotation { kind: number; d1: string[]; d2: string[] }

export interface ClassInfo {
    name: string;
    access: number;
    superName?: string;
    interfaces: string[];
    typeParams: string[];
    /** Superclass and interfaces with type arguments (from the Signature attribute when present). */
    supertypes: JavaType[];
    kotlin: boolean;
    metadata?: KotlinMetadataAnnotation;
    fields: FieldInfo[];
    methods: MethodInfo[];
    innerClasses: InnerClassInfo[];
    /** Unqualified exports of a `module-info` class. */
    exports: string[];
    /** Utf8 constants of Kotlin classes: they include the declared names from `@kotlin.Metadata`. */
    strings: Set<string>;
}

type AnnotationValue = number | string | AnnotationValue[] | { enumValue: string } | { annotation: Annotation };
interface Annotation { type: string; values: Map<string, AnnotationValue> }

export function parseClass(buf: Buffer): ClassInfo {
    if (buf.readUInt32BE(0) !== 0xcafebabe) { throw new Error("not a class file"); }
    const count = buf.readUInt16BE(8);
    const tags = new Uint8Array(count);
    const at = new Uint32Array(count);
    let kotlin = false;
    let p = 10;
    for (let i = 1; i < count; i++) {
        tags[i] = buf[p];
        at[i] = p + 1;
        switch (buf[p]) {
            case 1: {
                const length = buf.readUInt16BE(p + 1);
                if (length === 17 && buf.toString("latin1", p + 3, p + 20) === "Lkotlin/Metadata;") { kotlin = true; }
                p += 3 + length;
                break;
            }
            case 7: case 8: case 16: case 19: case 20: p += 3; break;
            case 15: p += 4; break;
            case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18: p += 5; break;
            case 5: case 6: p += 9; i++; break;
            default: throw new Error(`bad constant pool tag ${buf[p]}`);
        }
    }
    const utf8 = (i: number) => buf.toString("utf8", at[i] + 2, at[i] + 2 + buf.readUInt16BE(at[i]));
    /** Class, String, Module and Package entries point to a Utf8 entry. */
    const ref = (i: number) => utf8(buf.readUInt16BE(at[i]));
    const u2 = () => { p += 2; return buf.readUInt16BE(p - 2); };
    const u4 = () => { p += 4; return buf.readUInt32BE(p - 4); };

    const constant = (i: number, descriptor: string): string | undefined => {
        switch (tags[i]) {
            case 3: {
                const v = buf.readInt32BE(at[i]);
                if (descriptor === "Z") { return String(v !== 0); }
                return descriptor === "C" ? `'${JSON.stringify(String.fromCharCode(v)).slice(1, -1)}'` : String(v);
            }
            case 4: { const v = buf.readFloatBE(at[i]); return Number.isFinite(v) ? `${v}f` : String(v); }
            case 5: return `${buf.readBigInt64BE(at[i])}L`;
            case 6: return String(buf.readDoubleBE(at[i]));
            case 8: { const s = ref(i); return JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s); }
        }
        return undefined;
    };

    /** Annotation element values; strings are decoded as modified UTF-8 (`@Metadata.d1` contains NUL bytes). */
    const elementValue = (q: number): [AnnotationValue, number] => {
        const tag = String.fromCharCode(buf[q]);
        const index = buf.readUInt16BE(q + 1);
        switch (tag) {
            case "s": return [modifiedUtf8(buf, at[index] + 2, at[index] + 2 + buf.readUInt16BE(at[index])), q + 3];
            case "e": return [{ enumValue: utf8(buf.readUInt16BE(q + 3)) }, q + 5];
            case "@": { const [annotation, next] = readAnnotation(q + 1); return [{ annotation }, next]; }
            case "[": {
                const values: AnnotationValue[] = [];
                let r = q + 3;
                for (let n = index; n > 0; n--) {
                    const [value, next] = elementValue(r);
                    values.push(value);
                    r = next;
                }
                return [values, r];
            }
            case "c": return [utf8(index), q + 3];
            default: return [tags[index] === 3 ? buf.readInt32BE(at[index]) : 0, q + 3];
        }
    };
    const readAnnotation = (q: number): [Annotation, number] => {
        const type = utf8(buf.readUInt16BE(q));
        const values = new Map<string, AnnotationValue>();
        let r = q + 4;
        for (let n = buf.readUInt16BE(q + 2); n > 0; n--) {
            const name = utf8(buf.readUInt16BE(r));
            const [value, next] = elementValue(r + 2);
            values.set(name, value);
            r = next;
        }
        return [{ type, values }, r];
    };
    const annotations = (q: number): Annotation[] => {
        const result: Annotation[] = [];
        let r = q + 2;
        for (let n = buf.readUInt16BE(q); n > 0; n--) {
            const [annotation, next] = readAnnotation(r);
            result.push(annotation);
            r = next;
        }
        return result;
    };
    /** [deprecated, hidden] from `@java.lang.Deprecated` / `@kotlin.Deprecated(level = ...)`. */
    const deprecation = (list: Annotation[]): [boolean, boolean] => {
        const kotlinDeprecated = list.find(a => a.type === "Lkotlin/Deprecated;");
        const level = kotlinDeprecated?.values.get("level");
        const hidden = typeof level === "object" && !Array.isArray(level) && "enumValue" in level && level.enumValue === "HIDDEN";
        return [!!kotlinDeprecated || list.some(a => a.type === "Ljava/lang/Deprecated;"), hidden];
    };

    /** Parameter names from the LocalVariableTable of a Code attribute, by slot. */
    const localVariables = (q: number): Map<number, string> => {
        const vars = new Map<number, string>();
        q += 4;
        q += 4 + buf.readUInt32BE(q);
        q += 2 + 8 * buf.readUInt16BE(q);
        for (let n = buf.readUInt16BE(q), r = q + 2; n > 0; n--) {
            const length = buf.readUInt32BE(r + 2);
            if (utf8(buf.readUInt16BE(r)) === "LocalVariableTable") {
                for (let k = buf.readUInt16BE(r + 6), e = r + 8; k > 0; k--, e += 10) {
                    if (buf.readUInt16BE(e) === 0) { vars.set(buf.readUInt16BE(e + 8), utf8(buf.readUInt16BE(e + 4))); }
                }
            }
            r += 6 + length;
        }
        return vars;
    };

    const access = u2();
    const name = ref(u2());
    const superIndex = u2();
    const interfaces: string[] = [];
    for (let n = u2(); n > 0; n--) { interfaces.push(ref(u2())); }

    const fields: FieldInfo[] = [];
    for (let n = u2(); n > 0; n--) {
        const fieldAccess = u2(), fieldName = utf8(u2()), descriptor = utf8(u2());
        let signature: string | undefined, value: string | undefined, deprecated = false, hidden = false;
        for (let a = u2(); a > 0; a--) {
            const attribute = utf8(u2()), end = u4() + p;
            if (attribute === "Signature") { signature = utf8(buf.readUInt16BE(p)); }
            else if (attribute === "ConstantValue") { value = constant(buf.readUInt16BE(p), descriptor); }
            else if (attribute === "Deprecated") { deprecated = true; }
            else if (attribute === "RuntimeVisibleAnnotations") {
                const [d, h] = deprecation(annotations(p));
                deprecated ||= d;
                hidden = h;
            }
            p = end;
        }
        const java = parseType(signature ?? descriptor, 0)[0];
        fields.push({ access: fieldAccess, name: fieldName, descriptor, type: renderJava(java), java, constant: value, deprecated, hidden });
    }

    const methods: MethodInfo[] = [];
    for (let n = u2(); n > 0; n--) {
        const methodAccess = u2(), methodName = utf8(u2()), descriptor = utf8(u2());
        let signature: string | undefined, deprecated = false, hidden = false;
        let declared: Array<string | undefined> | undefined, locals: Map<number, string> | undefined;
        for (let a = u2(); a > 0; a--) {
            const attribute = utf8(u2()), end = u4() + p;
            if (attribute === "Signature") { signature = utf8(buf.readUInt16BE(p)); }
            else if (attribute === "Deprecated") { deprecated = true; }
            else if (attribute === "Code") { locals = localVariables(p); }
            else if (attribute === "RuntimeVisibleAnnotations") {
                const [d, h] = deprecation(annotations(p));
                deprecated ||= d;
                hidden = h;
            } else if (attribute === "MethodParameters") {
                declared = [];
                for (let k = buf[p], q = p + 1; k > 0; k--, q += 4) {
                    const index = buf.readUInt16BE(q);
                    declared.push(index ? utf8(index) : undefined);
                }
            }
            p = end;
        }
        methods.push(method(methodAccess, methodName, descriptor, signature, kotlin, deprecated, hidden, declared, locals));
    }

    const innerClasses: InnerClassInfo[] = [];
    const exports: string[] = [];
    let classSignature: string | undefined;
    let metadata: KotlinMetadataAnnotation | undefined;
    for (let a = u2(); a > 0; a--) {
        const attribute = utf8(u2()), end = u4() + p;
        if (attribute === "InnerClasses") {
            for (let k = u2(); k > 0; k--) {
                const inner = u2(), outer = u2(), simple = u2(), flags = u2();
                innerClasses.push({ name: ref(inner), outer: outer ? ref(outer) : undefined, simpleName: simple ? utf8(simple) : undefined, access: flags });
            }
        } else if (attribute === "Signature") {
            classSignature = utf8(buf.readUInt16BE(p));
        } else if (attribute === "RuntimeVisibleAnnotations" && kotlin) {
            const m = annotations(p).find(x => x.type === "Lkotlin/Metadata;");
            const strings = (v: AnnotationValue | undefined) => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
            if (m) {
                const k = m.values.get("k");
                metadata = { kind: typeof k === "number" ? k : 1, d1: strings(m.values.get("d1")), d2: strings(m.values.get("d2")) };
            }
        } else if (attribute === "Module") {
            p += 6;
            const requires = u2();
            p += 6 * requires;
            for (let k = u2(); k > 0; k--) {
                const pkg = u2();
                p += 2;
                const targets = u2();
                p += 2 * targets;
                if (targets === 0) { exports.push(ref(pkg)); }
            }
        }
        p = end;
    }
    const strings = new Set<string>();
    for (let i = 1; kotlin && i < count; i++) {
        if (tags[i] === 1) { strings.add(utf8(i)); }
    }
    const superName = superIndex ? ref(superIndex) : undefined;
    let typeParams: string[] = [];
    let supertypes: JavaType[] = [superName, ...interfaces].filter((s): s is string => !!s).map(s => ({ kind: "class", name: s, args: [] }));
    if (classSignature) {
        const [params, next] = parseTypeParams(classSignature, 0);
        typeParams = params;
        supertypes = [];
        for (let i = next; i < classSignature.length;) {
            const [type, after] = parseType(classSignature, i);
            supertypes.push(type);
            i = after;
        }
    }
    return { name, access, superName, interfaces, typeParams, supertypes, kotlin, metadata, fields, methods, innerClasses, exports, strings };
}

/** The JVM's modified UTF-8: NUL is `C0 80`, which a standard UTF-8 decoder rejects. */
function modifiedUtf8(buf: Buffer, start: number, end: number): string {
    const chars: number[] = [];
    for (let i = start; i < end;) {
        const b = buf[i];
        if (b < 0x80) { chars.push(b); i += 1; }
        else if ((b & 0xe0) === 0xc0) { chars.push(((b & 0x1f) << 6) | (buf[i + 1] & 0x3f)); i += 2; }
        else { chars.push(((b & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f)); i += 3; }
    }
    let s = "";
    for (let i = 0; i < chars.length; i += 8192) { s += String.fromCharCode(...chars.slice(i, i + 8192)); }
    return s;
}

function method(
    access: number, name: string, descriptor: string, signature: string | undefined, kotlin: boolean, deprecated: boolean, hidden: boolean,
    declared: Array<string | undefined> | undefined, locals: Map<number, string> | undefined,
): MethodInfo {
    const raw = descriptorParams(descriptor);
    let sig = signature ? parseMethodSignature(signature) : undefined;
    if (!sig || sig.params.length !== raw.length) { sig = parseMethodSignature(descriptor); }
    let slot = access & ACC_STATIC ? 0 : 1;
    const params: Param[] = sig.params.map((java, i) => {
        const paramName = declared?.[i] ?? locals?.get(slot);
        slot += raw[i] === "J" || raw[i] === "D" ? 2 : 1;
        return { name: paramName && /^[A-Za-z_]\w*$/.test(paramName) ? paramName : undefined, type: renderJava(java), java };
    });
    let returnJava = sig.returnType;
    // Kotlin `suspend fun f(): T` compiles to `Object f(Continuation<? super T>)`.
    const suspend = kotlin && raw[raw.length - 1] === "Lkotlin/coroutines/Continuation;";
    if (suspend) {
        const continuation = params.pop()!.java;
        returnJava = continuation.kind === "class" && continuation.args[0]?.type || { kind: "class", name: "java/lang/Object", args: [] };
    }
    return { access, name, descriptor, typeParams: sig.typeParams, params, returnType: renderJava(returnJava), returnJava, suspend, deprecated, hidden };
}

function descriptorParams(descriptor: string): string[] {
    const params: string[] = [];
    for (let i = 1; i < descriptor.length && descriptor[i] !== ")";) {
        const start = i;
        while (descriptor[i] === "[") { i++; }
        i = descriptor[i] === "L" ? descriptor.indexOf(";", i) + 1 : i + 1;
        params.push(descriptor.slice(start, i));
    }
    return params;
}

/** `<T:Ljava/lang/Object;U::Ljava/lang/Comparable<TU;>;>` → `["T", "U"]` and the index after `>`. */
function parseTypeParams(s: string, i: number): [string[], number] {
    const names: string[] = [];
    if (s[i] !== "<") { return [names, i]; }
    i++;
    while (i < s.length && s[i] !== ">") {
        const colon = s.indexOf(":", i);
        names.push(s.slice(i, colon));
        i = colon;
        while (s[i] === ":") {
            i++;
            if (s[i] === "L" || s[i] === "T" || s[i] === "[") { i = parseType(s, i)[1]; }
        }
    }
    return [names, i + 1];
}

/** Parses a method descriptor or generic signature (`<T:Ljava/lang/Object;>(TT;)Ljava/util/List<TT;>;`). */
function parseMethodSignature(s: string): { typeParams: string[]; params: JavaType[]; returnType: JavaType } {
    const [typeParams, start] = parseTypeParams(s, 0);
    const params: JavaType[] = [];
    let i = start + 1;
    while (i < s.length && s[i] !== ")") {
        const [type, next] = parseType(s, i);
        params.push(type);
        i = next;
    }
    return { typeParams, params, returnType: parseType(s, i + 1)[0] };
}

function parseType(s: string, i: number): [JavaType, number] {
    const c = s[i];
    if (c === "[") {
        const [element, next] = parseType(s, i + 1);
        return [{ kind: "array", element }, next];
    }
    if (c === "T") {
        const end = s.indexOf(";", i);
        return [{ kind: "var", name: s.slice(i + 1, end) }, end + 1];
    }
    if (c !== "L") { return [{ kind: "primitive", code: c ?? "V" }, i + 1]; }
    let name = "";
    let args: JavaTypeArg[] = [];
    let j = i + 1;
    while (j < s.length && s[j] !== ";") {
        if (s[j] === "<") {
            args = [];
            for (j++; j < s.length && s[j] !== ">";) {
                if (s[j] === "*") { args.push({ variance: "*" }); j++; continue; }
                const variance = s[j] === "+" ? "out" : s[j] === "-" ? "in" : "";
                const [type, next] = parseType(s, variance ? j + 1 : j);
                args.push({ variance, type });
                j = next;
            }
            j++;
        } else if (s[j] === ".") {
            name += "$";
            args = [];
            j++;
        } else {
            name += s[j++];
        }
    }
    return [{ kind: "class", name, args }, j + 1];
}

const PRIMITIVES: Record<string, string> = {
    B: "Byte", C: "Char", D: "Double", F: "Float", I: "Int", J: "Long", S: "Short", Z: "Boolean", V: "Unit",
};

const KOTLIN_NAMES: Record<string, string> = {
    "java/lang/Object": "Any", "java/lang/Integer": "Int", "java/lang/Character": "Char", "java/util/Map$Entry": "Map.Entry",
};

/** Kotlin-style rendering of a Java type: `Comparator<in T>`, `IntArray`, `(T) -> R`. */
export function renderJava(t: JavaType): string {
    switch (t.kind) {
        case "primitive": return PRIMITIVES[t.code] ?? "Any";
        case "var": return t.name;
        case "array": return t.element.kind === "primitive" ? `${PRIMITIVES[t.element.code]}Array` : `Array<${renderJava(t.element)}>`;
    }
    const args = t.args.map(a => a.variance === "*" ? "*" : `${a.variance ? `${a.variance} ` : ""}${renderJava(a.type!)}`);
    if (args.length && /^kotlin\/jvm\/functions\/Function\d+$/.test(t.name)) {
        const types = args.map(a => a.replace(/^(?:in|out) /, ""));
        return `(${types.slice(0, -1).join(", ")}) -> ${types[types.length - 1]}`;
    }
    const simple = KOTLIN_NAMES[t.name] ?? t.name.slice(t.name.lastIndexOf("/") + 1).replace(/\$/g, ".");
    return args.length ? `${simple}<${args.join(", ")}>` : simple;
}
