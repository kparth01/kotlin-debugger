import { KotlinMetadataAnnotation } from "./classfile";
import { ANY, KArg, KType } from "./types";

/*
 * Kotlin declarations from `@kotlin.Metadata` (d1: protobuf, d2: strings) and from the `.kotlin_builtins`
 * files of kotlin-stdlib (List, MutableList, String, Int, ...). Field numbers follow metadata.proto and
 * jvm_metadata.proto of the Kotlin compiler.
 */

export type Visibility = "internal" | "private" | "protected" | "public" | "privateToThis" | "local";
export type ClassKind = "class" | "interface" | "enum" | "enumEntry" | "annotation" | "object" | "companion";

export interface KTypeParam { name: string; bounds: KType[] }
export interface KParam { name: string; type: KType; vararg: boolean; hasDefault: boolean }

export interface KFunction {
    name: string;
    visibility: Visibility;
    /** 0 declaration, 1 fake override, 2 delegation, 3 synthesized (data class `copy`, `componentN`). */
    memberKind: number;
    typeParams: KTypeParam[];
    receiver?: KType;
    params: KParam[];
    returnType: KType;
    suspend: boolean;
    infix: boolean;
    operator: boolean;
    jvmName?: string;
    jvmDesc?: string;
}

export interface KProperty {
    name: string;
    visibility: Visibility;
    memberKind: number;
    typeParams: KTypeParam[];
    receiver?: KType;
    returnType: KType;
    isVar: boolean;
    isConst: boolean;
}

export interface KTypeAlias { name: string; typeParams: KTypeParam[]; expanded: KType }

export interface KClass {
    /** `kotlin/collections/Map.Entry` */
    id: string;
    kind: ClassKind;
    visibility: Visibility;
    typeParams: KTypeParam[];
    supertypes: KType[];
    constructors: KParam[][];
    functions: KFunction[];
    properties: KProperty[];
    companion?: string;
    nested: string[];
    enumEntries: string[];
}

export interface KPackage { functions: KFunction[]; properties: KProperty[]; typeAliases: KTypeAlias[] }

// ---------------------------------------------------------------------------------------------
// Protobuf wire format

class Proto {
    private readonly fields = new Map<number, Array<number | Buffer>>();

    constructor(buf: Buffer) {
        let p = 0;
        while (p < buf.length) {
            const [key, afterKey] = varint(buf, p);
            p = afterKey;
            let value: number | Buffer;
            switch (key & 7) {
                case 0: [value, p] = varint(buf, p); break;
                case 1: value = 0; p += 8; break;
                case 2: {
                    const [length, start] = varint(buf, p);
                    value = buf.subarray(start, start + length);
                    p = start + length;
                    break;
                }
                case 5: value = buf.readUInt32LE(p); p += 4; break;
                default: throw new Error(`unsupported protobuf wire type ${key & 7}`);
            }
            const field = key >>> 3;
            const values = this.fields.get(field);
            if (values) { values.push(value); } else { this.fields.set(field, [value]); }
        }
    }

    has(field: number): boolean { return this.fields.has(field); }

    int(field: number, fallback = 0): number {
        const values = this.fields.get(field);
        const v = values?.[values.length - 1];
        return typeof v === "number" ? v : fallback;
    }

    /** Repeated int32, packed or not. */
    ints(field: number): number[] {
        const out: number[] = [];
        for (const v of this.fields.get(field) ?? []) {
            if (typeof v === "number") { out.push(v); continue; }
            for (let p = 0; p < v.length;) {
                const [n, next] = varint(v, p);
                out.push(n);
                p = next;
            }
        }
        return out;
    }

    message(field: number): Proto | undefined {
        const values = this.fields.get(field);
        const v = values?.[values.length - 1];
        return v instanceof Buffer ? new Proto(v) : undefined;
    }

    messages(field: number): Proto[] {
        return (this.fields.get(field) ?? []).filter((v): v is Buffer => v instanceof Buffer).map(v => new Proto(v));
    }

    strings(field: number): string[] {
        return (this.fields.get(field) ?? []).filter((v): v is Buffer => v instanceof Buffer).map(v => v.toString("utf8"));
    }
}

/** Varint as a signed 32-bit value (enough for every int32/enum/bool field used here). */
function varint(buf: Buffer, p: number): [number, number] {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
        b = buf[p++];
        if (shift < 32) { result |= (b & 0x7f) << shift; }
        shift += 7;
    } while (b & 0x80 && p < buf.length);
    return [result, p];
}

// ---------------------------------------------------------------------------------------------
// Name tables

interface Names {
    string(index: number): string;
    /** `kotlin/collections/Map.Entry` */
    className(index: number): string;
}

const PREDEFINED = [
    "Any", "Nothing", "Unit", "Throwable", "Number", "Byte", "Double", "Float", "Int", "Long", "Short", "Boolean", "Char",
    "CharSequence", "String", "Comparable", "Enum", "Array", "ByteArray", "DoubleArray", "FloatArray", "IntArray",
    "LongArray", "ShortArray", "BooleanArray", "CharArray", "Cloneable", "Annotation",
    "collections/Iterable", "collections/MutableIterable", "collections/Collection", "collections/MutableCollection",
    "collections/List", "collections/MutableList", "collections/Set", "collections/MutableSet", "collections/Map",
    "collections/MutableMap", "collections/Map.Entry", "collections/MutableMap.MutableEntry", "collections/Iterator",
    "collections/MutableIterator", "collections/ListIterator", "collections/MutableListIterator",
].map(s => `kotlin/${s}`);

/** JvmNameResolver: `StringTableTypes` records applied to the d2 strings. */
class JvmNames implements Names {
    private readonly records: Proto[] = [];
    private readonly cache = new Map<number, string>();

    constructor(types: Proto, private readonly strings: string[]) {
        for (const record of types.messages(1)) {
            for (let n = record.int(1, 1); n > 0; n--) { this.records.push(record); }
        }
    }

    string(index: number): string {
        let s = this.cache.get(index);
        if (s !== undefined) { return s; }
        const record = this.records[index];
        s = record?.strings(6)[0]
            ?? (record?.has(2) ? PREDEFINED[record.int(2)] : undefined)
            ?? this.strings[index] ?? "";
        if (record) {
            const substring = record.ints(4);
            if (substring.length >= 2 && substring[0] >= 0 && substring[0] <= substring[1] && substring[1] <= s.length) {
                s = s.slice(substring[0], substring[1]);
            }
            const replace = record.ints(5);
            if (replace.length >= 2) { s = s.split(String.fromCharCode(replace[0])).join(String.fromCharCode(replace[1])); }
            const operation = record.int(3);
            if (operation === 1) { s = s.replace(/\$/g, "."); }
            if (operation === 2) { s = (s.length >= 2 ? s.slice(1, -1) : s).replace(/\$/g, "."); }
        }
        this.cache.set(index, s);
        return s;
    }

    className(index: number): string { return this.string(index); }
}

/** Builtins: StringTable plus QualifiedNameTable (parent, short name, kind CLASS=0 / PACKAGE=1 / LOCAL=2). */
class BuiltinNames implements Names {
    private readonly strings: string[];
    private readonly qualified: Proto[];

    constructor(strings: Proto | undefined, qualified: Proto | undefined) {
        this.strings = strings?.strings(1) ?? [];
        this.qualified = qualified?.messages(1) ?? [];
    }

    string(index: number): string { return this.strings[index] ?? ""; }

    className(index: number): string {
        const pkg: string[] = [];
        const cls: string[] = [];
        for (let i = index, guard = 0; i !== -1 && guard < 50; guard++) {
            const q = this.qualified[i];
            if (!q) { break; }
            (q.int(3, 1) === 1 ? pkg : cls).unshift(this.string(q.int(2)));
            i = q.int(1, -1);
        }
        return pkg.length ? `${pkg.join("/")}/${cls.join(".")}` : cls.join(".");
    }
}

// ---------------------------------------------------------------------------------------------
// Declarations

const VISIBILITY: Visibility[] = ["internal", "private", "protected", "public", "privateToThis", "local"];
const CLASS_KIND: ClassKind[] = ["class", "interface", "enum", "enumEntry", "annotation", "object", "companion"];
const bit = (flags: number, n: number) => (flags & (1 << n)) !== 0;

class Decoder {
    private readonly scopes: Array<Map<number, string>> = [];
    private typeTable: Proto[] = [];
    private firstNullable = -1;

    constructor(private readonly names: Names, table: Proto | undefined) { this.useTypeTable(table); }

    private useTypeTable(table: Proto | undefined) {
        if (!table) { return; }
        this.typeTable = table.messages(1);
        this.firstNullable = table.int(2, -1);
    }

    private typeParams(protos: Proto[]): KTypeParam[] {
        const scope = new Map<number, string>();
        this.scopes.push(scope);
        for (const p of protos) { scope.set(p.int(1), this.names.string(p.int(2))); }
        return protos.map(p => ({
            name: this.names.string(p.int(2)),
            bounds: [...p.messages(5).map(b => this.type(b)), ...p.ints(6).map(id => this.typeById(id))],
        }));
    }

    private param(id: number): string {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            const name = this.scopes[i].get(id);
            if (name) { return name; }
        }
        return "T";
    }

    private typeById(id: number): KType {
        const proto = this.typeTable[id];
        if (!proto) { return ANY; }
        const t = this.type(proto);
        return this.firstNullable >= 0 && id >= this.firstNullable ? { ...t, nullable: true } : t;
    }

    private optionalType(proto: Proto | undefined, idField: number | undefined): KType | undefined {
        if (proto) { return this.type(proto); }
        return idField !== undefined ? this.typeById(idField) : undefined;
    }

    type(t: Proto): KType {
        const args: KArg[] = t.messages(2).map(a => {
            const projection = a.int(1, 2);
            if (projection === 3) { return { variance: "*" }; }
            const type = this.optionalType(a.message(2), a.has(3) ? a.int(3) : undefined) ?? ANY;
            return { variance: projection === 0 ? "in" : projection === 1 ? "out" : "", type };
        });
        const nullable = t.int(3) !== 0;
        if (t.has(7)) { return { param: this.param(t.int(7)), args: [], nullable }; }
        if (t.has(9)) { return { param: this.names.string(t.int(9)), args: [], nullable }; }
        const id = t.has(6) ? this.names.className(t.int(6)) : t.has(12) ? this.names.className(t.int(12)) : "kotlin/Any";
        // JVM: type_annotation = 100, builtins: 150
        const extensionFunction = [...t.messages(100), ...t.messages(150)].some(a => this.names.className(a.int(1)) === "kotlin/ExtensionFunctionType");
        return { id, args, nullable, suspend: bit(t.int(1), 0) || undefined, extensionFunction: extensionFunction || undefined };
    }

    private valueParam(p: Proto): KParam {
        const vararg = this.optionalType(p.message(4), p.has(6) ? p.int(6) : undefined);
        return {
            name: this.names.string(p.int(2)),
            type: vararg ?? this.optionalType(p.message(3), p.has(5) ? p.int(5) : undefined) ?? ANY,
            vararg: !!vararg,
            hasDefault: bit(p.int(1), 1),
        };
    }

    func(f: Proto): KFunction {
        const flags = f.has(9) ? f.int(9) : 6;
        const typeParams = this.typeParams(f.messages(4));
        try {
            const signature = f.message(100);
            return {
                name: this.names.string(f.int(2)),
                visibility: VISIBILITY[(flags >> 1) & 7] ?? "public",
                memberKind: (flags >> 6) & 3,
                typeParams,
                receiver: this.optionalType(f.message(5), f.has(8) ? f.int(8) : undefined),
                params: f.messages(6).map(p => this.valueParam(p)),
                returnType: this.optionalType(f.message(3), f.has(7) ? f.int(7) : undefined) ?? ANY,
                operator: bit(flags, 8),
                infix: bit(flags, 9),
                suspend: bit(flags, 13),
                jvmName: signature?.has(1) ? this.names.string(signature.int(1)) : undefined,
                jvmDesc: signature?.has(2) ? this.names.string(signature.int(2)) : undefined,
            };
        } finally {
            this.scopes.pop();
        }
    }

    property(p: Proto): KProperty {
        const flags = p.has(11) ? p.int(11) : 518;
        const typeParams = this.typeParams(p.messages(4));
        try {
            return {
                name: this.names.string(p.int(2)),
                visibility: VISIBILITY[(flags >> 1) & 7] ?? "public",
                memberKind: (flags >> 6) & 3,
                typeParams,
                receiver: this.optionalType(p.message(5), p.has(10) ? p.int(10) : undefined),
                returnType: this.optionalType(p.message(3), p.has(9) ? p.int(9) : undefined) ?? ANY,
                isVar: bit(flags, 8),
                isConst: bit(flags, 11),
            };
        } finally {
            this.scopes.pop();
        }
    }

    private typeAlias(a: Proto): KTypeAlias {
        const typeParams = this.typeParams(a.messages(3));
        try {
            const expanded = this.optionalType(a.message(6), a.has(7) ? a.int(7) : undefined)
                ?? this.optionalType(a.message(4), a.has(5) ? a.int(5) : undefined) ?? ANY;
            return { name: this.names.string(a.int(2)), typeParams, expanded };
        } finally {
            this.scopes.pop();
        }
    }

    classOf(c: Proto): KClass {
        const flags = c.has(1) ? c.int(1) : 6;
        const outerTable = this.typeTable;
        const outerFirstNullable = this.firstNullable;
        this.useTypeTable(c.message(30));
        const typeParams = this.typeParams(c.messages(5));
        try {
            return {
                id: this.names.className(c.int(3)),
                kind: CLASS_KIND[(flags >> 6) & 7] ?? "class",
                visibility: VISIBILITY[(flags >> 1) & 7] ?? "public",
                typeParams,
                supertypes: [...c.messages(6).map(t => this.type(t)), ...c.ints(2).map(id => this.typeById(id))],
                constructors: c.messages(8).map(k => k.messages(2).map(p => this.valueParam(p))),
                functions: c.messages(9).map(f => this.func(f)),
                properties: c.messages(10).map(p => this.property(p)),
                companion: c.has(4) ? this.names.string(c.int(4)) : undefined,
                nested: c.ints(7).map(i => this.names.string(i)),
                enumEntries: c.messages(13).map(e => this.names.string(e.int(1))),
            };
        } finally {
            this.scopes.pop();
            this.typeTable = outerTable;
            this.firstNullable = outerFirstNullable;
        }
    }

    packageOf(p: Proto): KPackage {
        this.useTypeTable(p.message(30));
        return {
            functions: p.messages(3).map(f => this.func(f)),
            properties: p.messages(4).map(x => this.property(x)),
            typeAliases: p.messages(5).map(a => this.typeAlias(a)),
        };
    }
}

/** d1 as bytes: "UTF-8 mode" (first char NUL, one byte per char) or the legacy 8-to-7 bit encoding. */
function d1Bytes(d1: string[]): Buffer {
    let s = d1.join("");
    if (s.charCodeAt(0) === 0) {
        s = s.slice(1);
        const out = Buffer.alloc(s.length);
        for (let i = 0; i < s.length; i++) { out[i] = s.charCodeAt(i); }
        return out;
    }
    if (s.charCodeAt(0) === 0xffff) { s = s.slice(1); }
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) { bytes[i] = (s.charCodeAt(i) + 0x7f) & 0x7f; }
    const out = Buffer.alloc(Math.floor((7 * bytes.length) / 8));
    for (let i = 0, index = 0, b = 0; i < out.length; i++) {
        const first = bytes[index] >>> b;
        index++;
        const second = (bytes[index] & ((1 << (b + 1)) - 1)) << (7 - b);
        out[i] = first + second;
        if (b === 6) { index++; b = 0; } else { b++; }
    }
    return out;
}

/** Kind 1: class; 2: file facade; 5: multifile class part. Facades (4) and synthetic classes (3) declare nothing. */
export function decodeMetadata(m: KotlinMetadataAnnotation): { cls?: KClass; pkg?: KPackage } | undefined {
    if (m.kind !== 1 && m.kind !== 2 && m.kind !== 5) { return undefined; }
    const bytes = d1Bytes(m.d1);
    const [length, start] = varint(bytes, 0);
    const names = new JvmNames(new Proto(bytes.subarray(start, start + length)), m.d2);
    const body = new Proto(bytes.subarray(start + length));
    return m.kind === 1 ? { cls: new Decoder(names, undefined).classOf(body) } : { pkg: new Decoder(names, undefined).packageOf(body) };
}

/** A `.kotlin_builtins` file: binary version ints, then a PackageFragment (strings, names, package, classes). */
export function decodeBuiltins(buf: Buffer): { classes: KClass[]; pkg?: KPackage } {
    const start = 4 + 4 * buf.readInt32BE(0);
    const fragment = new Proto(buf.subarray(start));
    const names = new BuiltinNames(fragment.message(1), fragment.message(2));
    const pkg = fragment.message(3);
    return {
        classes: fragment.messages(4).map(c => new Decoder(names, undefined).classOf(c)),
        pkg: pkg && new Decoder(names, undefined).packageOf(pkg),
    };
}
