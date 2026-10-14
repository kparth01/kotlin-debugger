import { JavaType } from "./classfile";

/**
 * A Kotlin type. `id` is a class id: package with `/`, nesting with `.` (`kotlin/collections/Map.Entry`);
 * `param` is a type parameter name.
 */
export interface KType {
    id?: string;
    param?: string;
    args: KArg[];
    nullable: boolean;
    suspend?: boolean;
    /** `A.(B) -> C`: the first argument of the function type is the receiver. */
    extensionFunction?: boolean;
}

export interface KArg { variance: "" | "in" | "out" | "*"; type?: KType }

export const classType = (id: string, args: KArg[] = [], nullable = false): KType => ({ id, args, nullable });
export const ANY = classType("kotlin/Any");
export const NULLABLE_ANY = classType("kotlin/Any", [], true);

export function binaryToClassId(binary: string): string {
    const slash = binary.lastIndexOf("/");
    return binary.slice(0, slash + 1) + binary.slice(slash + 1).replace(/\$/g, ".");
}

export function classIdToBinary(id: string): string {
    const slash = id.lastIndexOf("/");
    return id.slice(0, slash + 1) + id.slice(slash + 1).replace(/\./g, "$");
}

export function packageOf(id: string): string {
    return id.slice(0, Math.max(0, id.lastIndexOf("/")));
}

const FUNCTION_TYPE = /^kotlin\/(?:jvm\/functions\/)?Function(\d+)$/;

export function isFunctionType(t: KType | undefined): boolean {
    return !!t?.id && FUNCTION_TYPE.test(t.id);
}

export function renderType(t: KType): string {
    const q = t.nullable ? "?" : "";
    if (t.param) { return t.param + q; }
    const id = t.id ?? "kotlin/Any";
    if (FUNCTION_TYPE.test(id) && t.args.length) {
        const types = t.args.map(a => a.type ? renderType(a.type) : "Any?");
        const result = types.pop();
        const receiver = t.extensionFunction && types.length ? `${types.shift()}.` : "";
        const fn = `${t.suspend ? "suspend " : ""}${receiver}(${types.join(", ")}) -> ${result}`;
        return q ? `(${fn})?` : fn;
    }
    const args = t.args.length
        ? `<${t.args.map(a => a.variance === "*" ? "*" : `${a.variance ? `${a.variance} ` : ""}${renderType(a.type!)}`).join(", ")}>`
        : "";
    return id.slice(id.lastIndexOf("/") + 1) + args + q;
}

export function substitute(t: KType, bindings: Map<string, KType>): KType {
    if (t.param) {
        const bound = bindings.get(t.param);
        return bound ? { ...bound, nullable: bound.nullable || t.nullable } : t;
    }
    if (!t.args.length) { return t; }
    return { ...t, args: t.args.map(a => a.type ? { variance: a.variance, type: substitute(a.type, bindings) } : a) };
}

/** Binds the type parameters in `params` by matching `pattern` against `actual`. */
export function unify(pattern: KType, actual: KType, params: Set<string>, bindings: Map<string, KType>): void {
    if (pattern.param) {
        if (params.has(pattern.param) && !bindings.has(pattern.param) && !actual.param) {
            bindings.set(pattern.param, { ...actual, nullable: actual.nullable && !pattern.nullable });
        }
        return;
    }
    if (pattern.id !== actual.id) { return; }
    pattern.args.forEach((a, i) => {
        const b = actual.args[i];
        if (a.type && b?.type) { unify(a.type, b.type, params, bindings); }
    });
}

/** The type argument of `t` at `index` as a plain type (`out T` → `T`, `*` → `Any?`). */
export function argType(t: KType, index: number): KType {
    return t.args[index]?.type ?? NULLABLE_ANY;
}

// ---------------------------------------------------------------------------------------------
// Java types as Kotlin sees them

const PRIMITIVES: Record<string, string> = {
    B: "kotlin/Byte", C: "kotlin/Char", D: "kotlin/Double", F: "kotlin/Float", I: "kotlin/Int", J: "kotlin/Long",
    S: "kotlin/Short", Z: "kotlin/Boolean", V: "kotlin/Unit",
};

/** Java class → Kotlin class [read-only, mutable]. Java signatures use the mutable side (platform types). */
const MAPPED: Record<string, [string, string?]> = {
    "java/lang/Object": ["kotlin/Any"],
    "java/lang/String": ["kotlin/String"],
    "java/lang/CharSequence": ["kotlin/CharSequence"],
    "java/lang/Throwable": ["kotlin/Throwable"],
    "java/lang/Cloneable": ["kotlin/Cloneable"],
    "java/lang/Number": ["kotlin/Number"],
    "java/lang/Comparable": ["kotlin/Comparable"],
    "java/lang/Enum": ["kotlin/Enum"],
    "java/lang/annotation/Annotation": ["kotlin/Annotation"],
    "java/lang/Byte": ["kotlin/Byte"], "java/lang/Short": ["kotlin/Short"], "java/lang/Integer": ["kotlin/Int"],
    "java/lang/Long": ["kotlin/Long"], "java/lang/Float": ["kotlin/Float"], "java/lang/Double": ["kotlin/Double"],
    "java/lang/Character": ["kotlin/Char"], "java/lang/Boolean": ["kotlin/Boolean"],
    "java/lang/Iterable": ["kotlin/collections/Iterable", "kotlin/collections/MutableIterable"],
    "java/util/Iterator": ["kotlin/collections/Iterator", "kotlin/collections/MutableIterator"],
    "java/util/ListIterator": ["kotlin/collections/ListIterator", "kotlin/collections/MutableListIterator"],
    "java/util/Collection": ["kotlin/collections/Collection", "kotlin/collections/MutableCollection"],
    "java/util/List": ["kotlin/collections/List", "kotlin/collections/MutableList"],
    "java/util/Set": ["kotlin/collections/Set", "kotlin/collections/MutableSet"],
    "java/util/Map": ["kotlin/collections/Map", "kotlin/collections/MutableMap"],
    "java/util/Map$Entry": ["kotlin/collections/Map.Entry", "kotlin/collections/MutableMap.MutableEntry"],
};

const TO_JAVA = new Map<string, string>();
for (const [java, kotlin] of Object.entries(MAPPED)) {
    for (const id of kotlin) { if (id) { TO_JAVA.set(id, java); } }
}

/** The JDK class behind a mapped Kotlin built-in (`kotlin/collections/MutableList` → `java/util/List`). */
export function javaClassOf(id: string): string | undefined {
    return TO_JAVA.get(id);
}

export function kotlinIdOfJava(binary: string): string {
    const mapped = MAPPED[binary];
    return mapped ? mapped[1] ?? mapped[0] : binaryToClassId(binary);
}

export function fromJava(t: JavaType): KType {
    switch (t.kind) {
        case "primitive": return classType(PRIMITIVES[t.code] ?? "kotlin/Any");
        case "var": return { param: t.name, args: [], nullable: false };
        case "array": {
            if (t.element.kind === "primitive") { return classType(`${PRIMITIVES[t.element.code]}Array`); }
            return classType("kotlin/Array", [{ variance: "", type: fromJava(t.element) }]);
        }
    }
    const args: KArg[] = t.args.map(a => a.variance === "*" ? { variance: "*" } : { variance: a.variance, type: fromJava(a.type!) });
    return classType(kotlinIdOfJava(t.name), args);
}
