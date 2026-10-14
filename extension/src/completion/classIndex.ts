import { ClassSource, DirSource, JImageSource } from "./archives";
import {
    ACC_ANNOTATION, ACC_BRIDGE, ACC_ENUM, ACC_FINAL, ACC_INTERFACE, ACC_PUBLIC, ACC_STATIC, ACC_SYNTHETIC, ACC_VARARGS,
    ClassInfo, FieldInfo, MethodInfo, parseClass,
} from "./classfile";

export type EntryKind =
    | "package" | "class" | "interface" | "enum" | "annotation"
    | "method" | "property" | "field" | "constant" | "enumConstant"
    | "variable" | "keyword" | "namedArgument";

export interface Entry {
    kind: EntryKind;
    name: string;
    /** Binary name of the declaring class; for class entries the class itself. */
    owner?: string;
    params?: Array<{ name?: string; type: string; hasDefault?: boolean }>;
    typeParams?: string[];
    type?: string;
    value?: string;
    suspend?: boolean;
    vararg?: boolean;
    deprecated?: boolean;
    inherited?: boolean;
    /** The qualifier is not imported in the file: the import that makes the completion compile. */
    importName?: string;
    /** Extension functions/properties: the receiver type and the declaring package. */
    receiver?: string;
    pkg?: string;
    isVar?: boolean;
    /** Insert as `name { }` (the last parameter is a lambda and the others are optional). */
    lambda?: boolean;
    /** Sort group: the receiver's own members, inherited, extensions, not-imported extensions, `Any` members. */
    group?: number;
}

export interface FileContext {
    packageName: string;
    imports: Array<{ name: string; alias?: string; star: boolean }>;
}

export function parseFileContext(text: string): FileContext {
    return {
        packageName: /^\s*package\s+([\w.]+)/m.exec(text)?.[1] ?? "",
        imports: [...text.matchAll(/^\s*import\s+([\w.]+?)(\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*(?:\/\/.*)?$/gm)]
            .map(m => ({ name: m[1], star: !!m[2], alias: m[3] })),
    };
}

/** The dotted qualifier before the last `.` of a line prefix: `x = StringUtils.isB` → `["StringUtils"]`. */
export function qualifierAt(linePrefix: string): string[] | undefined {
    const m = /(?:^|[^\w.?$])((?:[A-Za-z_]\w*\s*\.\s*)+)\w*$/.exec(linePrefix);
    return m?.[1].split(".").map(s => s.trim()).filter(Boolean);
}

const KOTLIN_DEFAULT_PACKAGES = [
    "kotlin", "kotlin/annotation", "kotlin/collections", "kotlin/comparisons", "kotlin/io",
    "kotlin/ranges", "kotlin/sequences", "kotlin/text", "kotlin/jvm", "java/lang",
];
/** Kotlin built-in types whose companion objects are implemented by `kotlin.jvm.internal.<Name>CompanionObject`. */
const BUILTIN_COMPANIONS = new Set(["Int", "Long", "Short", "Byte", "Char", "Float", "Double", "Boolean", "String", "Enum"]);
const MAX_UNIMPORTED_CANDIDATES = 8;
const DESKTOP_PACKAGES = /^(?:java\/awt|javax\/(?:swing|print|sound|imageio|accessibility|management|naming|sql\/rowset)|java\/applet|org\/(?:omg|w3c|xml|ietf))\//;

export class ClassIndex {
    private readonly sources = new Map<string, ClassSource>();
    private readonly bySimpleName = new Map<string, string[]>();
    private readonly packages = new Map<string, { packages: Set<string>; classes: Set<string> }>();
    private readonly parsed = new Map<string, ClassInfo | undefined>();

    /** Earlier sources win for duplicate class names, like on a JVM classpath. */
    constructor(private readonly classpath: ClassSource[]) {
        for (const source of classpath) {
            for (const name of source.classNames()) {
                if (this.sources.has(name)) { continue; }
                this.sources.set(name, source);
                const slash = name.lastIndexOf("/");
                const simple = name.slice(slash + 1);
                if (simple.includes("$") || simple === "module-info" || simple === "package-info") { continue; }
                this.packageNode(name.slice(0, Math.max(slash, 0))).classes.add(simple);
                const same = this.bySimpleName.get(simple);
                if (same) { same.push(name); } else { this.bySimpleName.set(simple, [name]); }
            }
        }
    }

    private packageNode(pkg: string): { packages: Set<string>; classes: Set<string> } {
        let node = this.packages.get(pkg);
        if (!node) {
            node = { packages: new Set(), classes: new Set() };
            this.packages.set(pkg, node);
            if (pkg) {
                const slash = pkg.lastIndexOf("/");
                this.packageNode(slash < 0 ? "" : pkg.slice(0, slash)).packages.add(pkg.slice(slash + 1));
            }
        }
        return node;
    }

    get size(): number { return this.sources.size; }

    classSources(): ClassSource[] { return this.classpath; }

    has(binaryName: string): boolean { return this.sources.has(binaryName); }

    hasPackage(path: string): boolean { return this.packages.has(path.replace(/\./g, "/")); }

    /** Compiled classes of the project itself (their `internal` members are visible). */
    isProject(binaryName: string): boolean { return this.sources.get(binaryName) instanceof DirSource; }

    isProjectSource(source: ClassSource): boolean { return source instanceof DirSource; }

    locationOf(binaryName: string): string | undefined { return this.sources.get(binaryName)?.location; }

    /**
     * Top-level classes whose simple name starts with `prefix` (ignoring case), best first: exact case, project and
     * library classes before the JDK, desktop JDK packages last, shorter names first.
     */
    classesStartingWith(prefix: string, limit: number): string[] {
        const lower = prefix.toLowerCase();
        const scored: Array<[number, string]> = [];
        for (const [simple, names] of this.bySimpleName) {
            if (!simple.toLowerCase().startsWith(lower)) { continue; }
            for (const n of names) {
                const jdk = this.sources.get(n) instanceof JImageSource;
                const score = (simple.startsWith(prefix) ? 0 : 10_000) + (DESKTOP_PACKAGES.test(n) ? 5_000 : 0) + (jdk ? 1_000 : 0) + simple.length;
                scored.push([score, n]);
            }
        }
        return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, limit).map(s => s[1]);
    }

    /** Simple names of the top-level classes in a package (`java/lang`). */
    packageClasses(pkg: string): string[] {
        return [...(this.packages.get(pkg)?.classes ?? [])];
    }

    complete(qualifier: string[], file: FileContext): Entry[] {
        const classes = this.resolve(qualifier, file);
        if (classes.length) {
            return classes.flatMap(c => this.members(c.name).map(e => ({ ...e, importName: c.importName })));
        }
        const prefix = qualifier.join("/");
        const node = this.packages.get(prefix);
        if (!node) { return []; }
        return [
            ...[...node.packages].map((name): Entry => ({ kind: "package", name })),
            ...[...node.classes].map((name): Entry => ({ kind: "class", name, owner: `${prefix}/${name}` })),
        ];
    }

    private resolve(qualifier: string[], file: FileContext): Array<{ name: string; importName?: string }> {
        const [first, ...rest] = qualifier;
        const visible = this.visibleClass(first, file);
        if (visible) {
            const nested = this.nestedClass(visible, rest);
            return nested ? [{ name: nested }] : [];
        }
        const qualified = this.classForDottedName(qualifier);
        if (qualified) { return [{ name: qualified }]; }
        if (this.packages.has(qualifier.join("/"))) { return []; }
        const candidates: Array<{ name: string; importName?: string }> = [];
        for (const name of (this.bySimpleName.get(first) ?? []).slice(0, MAX_UNIMPORTED_CANDIDATES)) {
            const nested = this.nestedClass(name, rest);
            if (nested) { candidates.push({ name: nested, importName: name.replace(/\//g, ".") }); }
        }
        return candidates;
    }

    /** Resolves a simple name like the Kotlin compiler: explicit imports, same package, star imports, default imports. */
    private visibleClass(simple: string, file: FileContext): string | undefined {
        for (const imp of file.imports) {
            if (!imp.star && (imp.alias ?? imp.name.slice(imp.name.lastIndexOf(".") + 1)) === simple) {
                const imported = this.classForDottedName(imp.name.split("."));
                if (imported) { return imported; }
            }
        }
        const pkg = file.packageName.replace(/\./g, "/");
        const local = pkg ? `${pkg}/${simple}` : simple;
        if (this.sources.has(local)) { return local; }
        for (const imp of file.imports) {
            if (!imp.star) { continue; }
            const outer = this.classForDottedName(imp.name.split("."));
            const name = outer ? `${outer}$${simple}` : `${imp.name.replace(/\./g, "/")}/${simple}`;
            if (this.sources.has(name)) { return name; }
        }
        const companion = `kotlin/jvm/internal/${simple}CompanionObject`;
        if (BUILTIN_COMPANIONS.has(simple) && this.sources.has(companion)) { return companion; }
        return KOTLIN_DEFAULT_PACKAGES.map(p => `${p}/${simple}`).find(n => this.sources.has(n));
    }

    /** `["java", "util", "Map", "Entry"]` → `java/util/Map$Entry` (longest package first). */
    private classForDottedName(segments: string[]): string | undefined {
        for (let i = segments.length - 1; i >= 0; i--) {
            const nested = this.nestedClass(segments.slice(0, i + 1).join("/"), segments.slice(i + 1));
            if (nested) { return nested; }
        }
        return undefined;
    }

    private nestedClass(outer: string, path: string[]): string | undefined {
        let name = outer;
        if (!this.sources.has(name)) { return undefined; }
        for (const segment of path) {
            name = `${name}$${segment}`;
            if (!this.sources.has(name)) { return undefined; }
        }
        return name;
    }

    classInfo(name: string): ClassInfo | undefined {
        if (!this.parsed.has(name)) {
            let info: ClassInfo | undefined;
            try {
                const bytes = this.sources.get(name)?.read(name);
                info = bytes && parseClass(bytes);
            } catch {
                info = undefined;
            }
            this.parsed.set(name, info);
        }
        return this.parsed.get(name);
    }

    /** What `ClassName.` offers: statics, nested classes, and members of a Kotlin `object` or companion. */
    members(name: string): Entry[] {
        const info = this.classInfo(name);
        if (!info) { return []; }
        const entries: Entry[] = [];
        let singleton: string | undefined;
        for (const f of info.fields) {
            if (!isPublic(f.access, f.name) || !(f.access & ACC_STATIC)) { continue; }
            if (info.kotlin && f.name === "INSTANCE" && f.descriptor === `L${name};`) { singleton = name; continue; }
            if (info.kotlin && f.descriptor === `L${name}$${f.name};`) { singleton = `${name}$${f.name}`; continue; }
            entries.push(fieldEntry(f, name, true));
        }
        entries.push(...methodEntries(info, true, false));
        if (info.access & ACC_ENUM && !info.kotlin) {
            entries.push({ kind: "property", name: "entries", type: `EnumEntries<${simpleName(name)}>`, owner: name });
        }
        for (const inner of info.innerClasses) {
            if (inner.outer === name && inner.simpleName && inner.name !== singleton && isPublic(inner.access, inner.simpleName)) {
                entries.push({ kind: classKind(inner.access), name: inner.simpleName, owner: inner.name });
            }
        }
        if (!singleton && info.kotlin && this.isCompanion(name)) { singleton = name; }
        if (singleton) { entries.push(...this.instanceMembers(singleton)); }
        const seen = new Set<string>();
        return entries.filter(e => {
            const key = `${e.kind}:${e.name}:${e.params?.map(p => p.type).join(",") ?? ""}`;
            return !seen.has(key) && !!seen.add(key);
        });
    }

    private isCompanion(name: string): boolean {
        const outer = name.includes("$") ? this.classInfo(name.slice(0, name.lastIndexOf("$"))) : undefined;
        return !!outer?.fields.some(f => f.access & ACC_STATIC && f.descriptor === `L${name};`);
    }

    private instanceMembers(name: string): Entry[] {
        const entries: Entry[] = [];
        let current: string | undefined = name;
        for (let depth = 0; current && current !== "java/lang/Object" && depth < 10; depth++) {
            const info = this.classInfo(current);
            if (!info) { break; }
            for (const f of info.fields) {
                if (isPublic(f.access, f.name) && !(f.access & ACC_STATIC)) {
                    entries.push({ ...fieldEntry(f, current, false), inherited: depth > 0 });
                }
            }
            entries.push(...methodEntries(info, false, depth > 0));
            current = info.superName;
        }
        return entries;
    }
}

/** Also drops compiler-generated names such as `access$x` and `f$default`. */
function isPublic(access: number, name: string): boolean {
    return (access & ACC_PUBLIC) !== 0 && (access & ACC_SYNTHETIC) === 0 && !name.includes("$");
}

function simpleName(binaryName: string): string {
    return binaryName.slice(binaryName.lastIndexOf("/") + 1).replace(/\$/g, ".");
}

function classKind(access: number): EntryKind {
    if (access & ACC_ANNOTATION) { return "annotation"; }
    if (access & ACC_INTERFACE) { return "interface"; }
    return access & ACC_ENUM ? "enum" : "class";
}

function fieldEntry(f: FieldInfo, owner: string, isStatic: boolean): Entry {
    const kind = f.access & ACC_ENUM ? "enumConstant" : isStatic && f.access & ACC_FINAL ? "constant" : "field";
    return { kind, name: f.name, type: f.type, value: f.constant, owner, deprecated: f.deprecated };
}

/** Kotlin code sees `getFoo()`/`isFoo()` of Kotlin classes as properties `foo`/`isFoo`. */
function propertyName(m: MethodInfo, info: ClassInfo): string | undefined {
    if (m.params.length || m.suspend || m.returnType === "Unit") { return undefined; }
    if (/^get[A-Z]/.test(m.name)) {
        // `getDefault` may belong to `default` or `Default`: the metadata strings name the real property.
        const name = m.name.slice(3);
        const lower = name[0].toLowerCase() + name.slice(1);
        if (info.strings.has(lower)) { return lower; }
        return info.strings.has(name) || /^[A-Z]{2}/.test(name) ? name : lower;
    }
    return /^is[A-Z]/.test(m.name) && m.returnType === "Boolean" ? m.name : undefined;
}

function methodEntries(info: ClassInfo, statics: boolean, inherited: boolean): Entry[] {
    const methods: MethodInfo[] = [];
    for (const m of info.methods) {
        if (!isPublic(m.access, m.name) || m.access & ACC_BRIDGE || m.name.startsWith("<") || !!(m.access & ACC_STATIC) !== statics) { continue; }
        // Value classes: `f-impl` and mangled statics implement instance members; elsewhere `f-UwyO8pc` is `f` in Kotlin.
        const dash = m.name.indexOf("-");
        if (dash >= 0 && (statics || /-impl\d*$/.test(m.name))) { continue; }
        methods.push(dash < 0 ? m : { ...m, name: m.name.slice(0, dash) });
    }
    const properties = new Map<string, Entry>();
    const entries: Entry[] = [];
    for (const m of methods) {
        const property = info.kotlin ? propertyName(m, info) : undefined;
        if (property) {
            if (!properties.has(property)) {
                properties.set(property, { kind: "property", name: property, type: m.returnType, owner: info.name, deprecated: m.deprecated, inherited });
            }
            continue;
        }
        entries.push({
            kind: "method", name: m.name, owner: info.name, params: m.params, typeParams: m.typeParams, type: m.returnType,
            suspend: m.suspend, vararg: (m.access & ACC_VARARGS) !== 0, deprecated: m.deprecated, inherited,
        });
    }
    const setter = (e: Entry) => {
        if (!info.kotlin || e.params?.length !== 1 || e.type !== "Unit" || !/^set[A-Z]/.test(e.name)) { return false; }
        const name = e.name.slice(3);
        return properties.has(name[0].toLowerCase() + name.slice(1)) || properties.has(name) || properties.has(`is${name}`);
    };
    return [...properties.values(), ...entries.filter(e => !setter(e))];
}
