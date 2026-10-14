import { ClassSource } from "./archives";
import { ACC_BRIDGE, ACC_FINAL, ACC_PUBLIC, ACC_STATIC, ACC_SYNTHETIC, ACC_VARARGS, ClassInfo, MethodInfo } from "./classfile";
import { ClassIndex, FileContext } from "./classIndex";
import { ClassKind, decodeBuiltins, decodeMetadata, KClass, KFunction, KParam, KProperty, KTypeParam, Visibility } from "./kotlinMetadata";
import {
    ANY, argType, classIdToBinary, classType, fromJava, javaClassOf, KType, NULLABLE_ANY, packageOf, substitute, unify,
} from "./types";

/** A function or property as Kotlin code sees it, with Kotlin types. */
export interface Member {
    kind: "function" | "property";
    name: string;
    typeParams: KTypeParam[];
    /** Extension receiver. */
    receiver?: KType;
    params: KParam[];
    returnType: KType;
    isVar?: boolean;
    suspend?: boolean;
    deprecated?: boolean;
    /** Declaring class id, or package (`kotlin/collections`) for top-level declarations. */
    owner: string;
    /** Java getter behind a synthetic property. */
    javaName?: string;
}

export interface FoundMember extends Member {
    inherited: boolean;
    /** Extension that is not imported in the file: the import to add. */
    importName?: string;
    extension?: boolean;
}

interface ClassModel {
    id: string;
    kind: ClassKind;
    typeParams: string[];
    supertypes: KType[];
    members: Member[];
    statics: Member[];
    constructors: KParam[][];
    companion?: string;
    java: boolean;
    builtin: boolean;
}

interface TypeAlias { typeParams: string[]; expanded: KType }

export interface PackageMember extends Member { pkg: string }

/** A class declared in the project's Kotlin sources; return types the source does not state are left out. */
export interface SourceClassModel {
    kind: ClassKind;
    typeParams: string[];
    supertypes: KType[];
    members: Array<Omit<Member, "returnType"> & { returnType?: KType }>;
    statics: Member[];
    constructors: KParam[][];
    companion?: string;
}

/** Declarations from source files (including unsaved editor text): newer than the compiled classes. */
export interface SourceProvider {
    exists(id: string): boolean;
    classIds(): string[];
    classModel(id: string): SourceClassModel | undefined;
    packageMembers(): PackageMember[];
}

interface SourceDeclarations { members: PackageMember[]; aliases: Map<string, TypeAlias> }

const sourceDeclarations = new WeakMap<ClassSource, SourceDeclarations>();
const sourceBuiltins = new WeakMap<ClassSource, KClass[]>();

const KOTLIN_DEFAULT_PACKAGES = [
    "kotlin", "kotlin/annotation", "kotlin/collections", "kotlin/comparisons", "kotlin/io",
    "kotlin/ranges", "kotlin/sequences", "kotlin/text", "kotlin/jvm",
];

/** JDK members that Kotlin exposes on the mapped built-ins (the rest is hidden by the built-in declarations). */
const JDK_MEMBERS_OF_BUILTINS: Record<string, string[]> = {
    "kotlin/Throwable": ["printStackTrace", "getStackTrace", "setStackTrace", "fillInStackTrace", "addSuppressed", "getSuppressed", "getLocalizedMessage", "initCause"],
    "kotlin/CharSequence": ["chars", "codePoints"],
    "kotlin/collections/Iterable": ["spliterator"],
    "kotlin/collections/MutableIterable": ["spliterator"],
    "kotlin/collections/Collection": ["stream", "parallelStream"],
    "kotlin/collections/MutableCollection": ["stream", "parallelStream", "removeIf"],
    "kotlin/collections/MutableList": ["replaceAll", "sort"],
    "kotlin/collections/Map": ["getOrDefault", "forEach"],
    "kotlin/collections/MutableMap": ["getOrDefault", "forEach", "putIfAbsent", "replace", "replaceAll", "compute", "computeIfAbsent", "computeIfPresent", "merge", "remove"],
};

/** Java methods that Kotlin shows differently on mapped types (`charAt` → `get`, `keySet()` → `keys`, ...). */
const RENAMED_BY_BUILTIN: Record<string, string> = {
    charAt: "kotlin/CharSequence", keySet: "kotlin/collections/Map", entrySet: "kotlin/collections/Map", toArray: "kotlin/collections/Collection",
    byteValue: "kotlin/Number", shortValue: "kotlin/Number", intValue: "kotlin/Number", longValue: "kotlin/Number",
    floatValue: "kotlin/Number", doubleValue: "kotlin/Number", charValue: "kotlin/Char",
};
const NEVER_VISIBLE = new Set(["getClass", "wait", "notify", "notifyAll", "finalize"]);

export class TypeSystem {
    private readonly models = new Map<string, ClassModel | undefined>();
    private readonly closures = new Map<string, Set<string>>();
    private readonly usable = new Map<string, boolean>();
    private builtins?: Map<string, KClass>;
    private declarations?: { extensions: Map<string, PackageMember[]>; topLevel: Map<string, PackageMember[]>; aliases: Map<string, TypeAlias> };

    constructor(private readonly index: ClassIndex, private readonly sources?: SourceProvider) {}

    /** Source declarations changed: models and top-level declarations are rebuilt on demand. */
    invalidate(): void {
        this.models.clear();
        this.closures.clear();
        this.declarations = undefined;
    }

    /** Reads the built-ins and all top-level declarations; returns how many were found. */
    warmUp(): number {
        this.builtinClasses();
        const d = this.decls();
        let count = 0;
        for (const list of [...d.extensions.values(), ...d.topLevel.values()]) { count += list.length; }
        return count;
    }

    // ---- classifiers

    private builtinClasses(): Map<string, KClass> {
        if (!this.builtins) {
            this.builtins = new Map();
            for (const source of this.index.classSources()) {
                let classes = sourceBuiltins.get(source);
                if (!classes) {
                    classes = (source.builtins?.() ?? []).flatMap(b => { try { return decodeBuiltins(b).classes; } catch { return []; } });
                    sourceBuiltins.set(source, classes);
                }
                for (const c of classes) { if (!this.builtins.has(c.id)) { this.builtins.set(c.id, c); } }
            }
        }
        return this.builtins;
    }

    /** A class id that exists as a built-in, a type alias or a class file. */
    exists(id: string): boolean {
        return this.builtinClasses().has(id) || this.decls().aliases.has(id) || this.index.has(classIdToBinary(id)) || !!this.sources?.exists(id);
    }

    /** `ArrayList<E>` (kotlin.collections) → `java.util.ArrayList<E>`. */
    expandAlias(t: KType): KType {
        for (let i = 0; i < 5 && t.id; i++) {
            const alias = this.decls().aliases.get(t.id);
            if (!alias) { break; }
            const bindings = new Map(alias.typeParams.map((p, k) => [p, argType(t, k)]));
            t = { ...substitute(alias.expanded, bindings), nullable: t.nullable || alias.expanded.nullable };
        }
        return t;
    }

    /** Resolves a (possibly qualified) class name in a file: imports, same package, star imports, default imports. */
    resolveClass(segments: string[], file: FileContext): string | undefined {
        const [first, ...rest] = segments;
        const nested = (outer: string | undefined) => {
            if (!outer) { return undefined; }
            const id = [outer, ...rest].join(".");
            return this.exists(id) ? id : undefined;
        };
        for (const imp of file.imports) {
            if (!imp.star && (imp.alias ?? imp.name.slice(imp.name.lastIndexOf(".") + 1)) === first) {
                const found = nested(this.qualified(imp.name.split(".")));
                if (found) { return found; }
            }
        }
        const pkg = file.packageName.replace(/\./g, "/");
        const candidates = [
            pkg ? `${pkg}/${first}` : first,
            ...file.imports.filter(i => i.star).flatMap(i => {
                const outer = this.qualified(i.name.split("."));
                return outer ? [`${outer}.${first}`] : [`${i.name.replace(/\./g, "/")}/${first}`];
            }),
            ...[...KOTLIN_DEFAULT_PACKAGES, "java/lang"].map(p => `${p}/${first}`),
        ];
        for (const c of candidates) {
            const found = nested(this.exists(c) ? c : undefined);
            if (found) { return found; }
        }
        return this.qualified(segments);
    }

    /** `Box<T>` for `class Box<T>`: the type of `this` inside the class. */
    selfType(id: string): KType {
        return classType(id, (this.model(id)?.typeParams ?? []).map(p => ({ variance: "", type: { param: p, args: [], nullable: false } })));
    }

    /** `["java", "util", "Map", "Entry"]` → `java/util/Map.Entry`. */
    private qualified(segments: string[]): string | undefined {
        for (let i = segments.length - 1; i >= 0; i--) {
            const id = `${segments.slice(0, i + 1).join("/")}${segments.length > i + 1 ? `.${segments.slice(i + 1).join(".")}` : ""}`;
            if (this.exists(id)) { return id; }
        }
        return undefined;
    }

    // ---- class models

    private model(id: string | undefined): ClassModel | undefined {
        if (!id) { return undefined; }
        if (!this.models.has(id)) {
            this.models.set(id, undefined);
            try { this.models.set(id, this.buildModel(id)); } catch { /* unreadable class */ }
        }
        return this.models.get(id);
    }

    private buildModel(id: string): ClassModel | undefined {
        const builtin = this.builtinClasses().get(id);
        if (builtin) {
            const model = this.kotlinModel(builtin, undefined, false);
            model.builtin = true;
            const java = javaClassOf(id);
            const allowed = JDK_MEMBERS_OF_BUILTINS[id];
            const jdk = java && allowed ? this.index.classInfo(java) : undefined;
            if (jdk) {
                const declared = new Set(model.members.map(m => `${m.name}/${m.params.length}`));
                for (const m of this.javaMembers(jdk, id).members) {
                    if (allowed.includes(m.name) && !declared.has(`${m.name}/${m.params.length}`)) { model.members.push(m); }
                }
            }
            return model;
        }
        const alias = this.decls().aliases.get(id);
        if (alias) { return this.model(this.expandAlias(classType(id)).id); }
        const compiled = this.compiledModel(id);
        const source = this.sources?.classModel(id);
        if (!source) { return compiled; }
        // The source is current; compiled classes supply the types it leaves to inference.
        const key = (m: { kind: string; name: string; params: unknown[] }) => `${m.kind}:${m.name}/${m.params.length}`;
        const compiledMembers = new Map((compiled?.members ?? []).map(m => [key(m), m]));
        return {
            id, kind: source.kind, typeParams: source.typeParams,
            supertypes: source.supertypes.length ? source.supertypes : compiled?.supertypes ?? [],
            members: source.members.map(m => ({ ...m, returnType: m.returnType ?? compiledMembers.get(key(m))?.returnType ?? ANY })),
            statics: source.statics.length ? source.statics : compiled?.statics ?? [],
            constructors: source.constructors.length ? source.constructors : compiled?.constructors ?? [],
            companion: source.companion ?? compiled?.companion, java: false, builtin: false,
        };
    }

    private compiledModel(id: string): ClassModel | undefined {
        const binary = classIdToBinary(id);
        const info = this.index.classInfo(binary);
        if (!info) { return undefined; }
        const meta = info.metadata && decodeMetadata(info.metadata)?.cls;
        return meta ? this.kotlinModel(meta, info, this.index.isProject(binary)) : this.javaModel(info, id);
    }

    private kotlinModel(c: KClass, info: ClassInfo | undefined, project: boolean): ClassModel {
        const methods = info?.methods.filter(m => !(m.access & ACC_STATIC)) ?? [];
        const members: Member[] = [];
        for (const f of c.functions) {
            if (!visible(f.visibility, project) || f.memberKind === 1) { continue; }
            const [deprecated, hidden] = jvmDeprecation(f, methods);
            if (!hidden) { members.push(functionMember(f, c.id, deprecated)); }
        }
        for (const p of c.properties) {
            if (visible(p.visibility, project) && p.memberKind !== 1) { members.push(propertyMember(p, c.id)); }
        }
        const self = classType(c.id, c.typeParams.map(p => ({ variance: "", type: { param: p.name, args: [], nullable: false } })));
        const statics: Member[] = c.enumEntries.map(name => ({ kind: "property", name, typeParams: [], params: [], returnType: classType(c.id), owner: c.id }));
        if (c.kind === "enum") {
            statics.push(
                { kind: "property", name: "entries", typeParams: [], params: [], returnType: classType("kotlin/enums/EnumEntries", [{ variance: "", type: self }]), owner: c.id },
                { kind: "function", name: "values", typeParams: [], params: [], returnType: classType("kotlin/Array", [{ variance: "", type: self }]), owner: c.id },
                { kind: "function", name: "valueOf", typeParams: [], params: [{ name: "value", type: classType("kotlin/String"), vararg: false, hasDefault: false }], returnType: self, owner: c.id },
            );
        }
        return {
            id: c.id, kind: c.kind, typeParams: c.typeParams.map(p => p.name), supertypes: c.supertypes, members, statics,
            constructors: c.constructors, companion: c.companion ? `${c.id}.${c.companion}` : undefined, java: false, builtin: false,
        };
    }

    private javaModel(info: ClassInfo, id: string): ClassModel {
        const { members, statics } = this.javaMembers(info, id);
        const constructors = info.methods.filter(m => m.name === "<init>" && m.access & ACC_PUBLIC).map(m => javaMethodMember(m, id).params);
        return {
            id, kind: info.access & 0x0200 ? "interface" : info.access & 0x4000 ? "enum" : "class",
            typeParams: info.typeParams, supertypes: info.supertypes.map(fromJava), members, statics, constructors, java: true, builtin: false,
        };
    }

    private javaMembers(info: ClassInfo, id: string): { members: Member[]; statics: Member[] } {
        const members: Member[] = [];
        const statics: Member[] = [];
        for (const m of info.methods) {
            if (!(m.access & ACC_PUBLIC) || m.access & (ACC_SYNTHETIC | ACC_BRIDGE) || m.name.startsWith("<") || m.name.includes("$")) { continue; }
            (m.access & ACC_STATIC ? statics : members).push(javaMethodMember(m, id));
        }
        for (const f of info.fields) {
            if (!(f.access & ACC_PUBLIC) || f.access & ACC_SYNTHETIC || f.name.includes("$")) { continue; }
            const member: Member = {
                kind: "property", name: f.name, typeParams: [], params: [], returnType: fromJava(f.java), isVar: !(f.access & ACC_FINAL),
                deprecated: f.deprecated, owner: id,
            };
            (f.access & ACC_STATIC ? statics : members).push(member);
        }
        return { members, statics };
    }

    // ---- supertypes and members

    /** The type and all its supertypes with substituted type arguments, nearest first; ends with `Any`. */
    supertypes(type: KType): KType[] {
        const out: KType[] = [];
        const seen = new Set<string>();
        const queue = [this.expandAlias(type)];
        while (queue.length && out.length < 80) {
            const t = queue.shift()!;
            if (!t.id || seen.has(t.id)) { continue; }
            seen.add(t.id);
            out.push(t);
            const model = this.model(t.id);
            if (!model) { continue; }
            const bindings = bind(model.typeParams, t);
            for (const s of model.supertypes) { queue.push(this.expandAlias(substitute(s, bindings))); }
        }
        if (!seen.has("kotlin/Any")) { out.push(ANY); }
        return out;
    }

    private supertypeIds(id: string): Set<string> {
        let ids = this.closures.get(id);
        if (!ids) {
            ids = new Set(this.supertypes(classType(id)).map(t => t.id!));
            this.closures.set(id, ids);
        }
        return ids;
    }

    isSubclass(id: string, of: string): boolean {
        return id === of || this.supertypeIds(id).has(of);
    }

    /** Instance members of `type`, including inherited ones; overrides hide the overridden declaration. */
    members(type: KType): FoundMember[] {
        const closure = this.supertypes(type);
        const ids = new Set(closure.map(t => t.id!));
        const builtinFunctions = new Set<string>();
        const builtinProperties = new Set<string>();
        for (const t of closure) {
            const model = this.model(t.id);
            if (!model?.builtin) { continue; }
            for (const m of model.members) {
                if (m.kind === "function") { builtinFunctions.add(`${m.name}/${m.params.length}`); } else { builtinProperties.add(m.name); }
            }
        }
        const out: FoundMember[] = [];
        const seen = new Set<string>();
        closure.forEach((t, depth) => {
            const model = this.model(t.id);
            if (!model) { return; }
            const bindings = bind(model.typeParams, t);
            const members = model.java ? kotlinViewOfJava(model.members, ids, builtinFunctions, builtinProperties) : model.members;
            for (const m of members) {
                const s = substituteMember(m, bindings);
                const key = memberKey(s);
                if (seen.has(key)) { continue; }
                seen.add(key);
                out.push({ ...s, inherited: depth > 0 });
            }
        });
        return out;
    }

    /** `ClassName.` in an expression: Java statics, enum entries, companion or object members. */
    staticMembers(id: string): Member[] {
        const model = this.model(id);
        if (!model) { return []; }
        if (model.java) { return model.statics; }
        if (model.kind === "object" || model.kind === "companion") { return this.members(classType(id)); }
        return [...model.statics, ...(model.companion ? this.members(classType(model.companion)) : [])];
    }

    constructors(id: string): KParam[][] {
        return this.model(id)?.constructors ?? [];
    }

    nestedClass(id: string, name: string): string | undefined {
        const nested = `${id}.${name}`;
        return this.exists(nested) ? nested : undefined;
    }

    // ---- top-level declarations: extensions, functions, type aliases

    private decls() {
        if (!this.declarations) {
            const extensions = new Map<string, PackageMember[]>();
            const topLevel = new Map<string, PackageMember[]>();
            const aliases = new Map<string, TypeAlias>();
            const add = (m: PackageMember, first: boolean) => {
                const key = m.receiver ? (m.receiver.param ? "*" : this.receiverKey(m.receiver)) : m.name;
                const map = m.receiver ? extensions : topLevel;
                const list = map.get(key);
                if (!list) { map.set(key, [m]); } else if (first) { list.unshift(m); } else { list.push(m); }
            };
            for (const source of this.index.classSources()) {
                const d = this.declarationsOf(source);
                for (const m of d.members) { add(m, false); }
                for (const [k, v] of d.aliases) { if (!aliases.has(k)) { aliases.set(k, v); } }
            }
            this.declarations = { extensions, topLevel, aliases };
            // Source declarations need the libraries' aliases to resolve their types; they win over compiled facades.
            for (const m of this.sources?.packageMembers() ?? []) { add(m, true); }
        }
        return this.declarations;
    }

    private receiverKey(t: KType): string {
        return t.id ?? "*";
    }

    private declarationsOf(source: ClassSource): SourceDeclarations {
        const cached = sourceDeclarations.get(source);
        if (cached) { return cached; }
        const result: SourceDeclarations = { members: [], aliases: new Map() };
        for (const name of source.classNames()) {
            const simple = name.slice(name.lastIndexOf("/") + 1);
            if (!/Kt(?:__\w+)?$/.test(simple) || simple.includes("$")) { continue; }
            const info = this.index.classInfo(name);
            if (!info?.metadata) { continue; }
            let pkg;
            try { pkg = decodeMetadata(info.metadata)?.pkg; } catch { continue; }
            if (!pkg) { continue; }
            const packageName = packageOf(name);
            const project = this.index.isProject(name);
            const statics = info.methods.filter(m => m.access & ACC_STATIC);
            for (const f of pkg.functions) {
                if (!visible(f.visibility, project)) { continue; }
                const [deprecated, hidden] = jvmDeprecation(f, statics);
                if (!hidden) { result.members.push({ ...functionMember(f, packageName, deprecated), pkg: packageName }); }
            }
            for (const p of pkg.properties) {
                if (visible(p.visibility, project)) { result.members.push({ ...propertyMember(p, packageName), pkg: packageName }); }
            }
            for (const a of pkg.typeAliases) {
                result.aliases.set(`${packageName}/${a.name}`, { typeParams: a.typeParams.map(p => p.name), expanded: a.expanded });
            }
        }
        // Project classes change between builds; libraries are cached with their archive.
        if (!this.index.isProjectSource(source)) { sourceDeclarations.set(source, result); }
        return result;
    }

    /** Extension functions and properties applicable to `type`, with type parameters bound by the receiver. */
    extensions(type: KType, file: FileContext): FoundMember[] {
        const closure = this.supertypes(type);
        const ids = new Set(closure.map(t => t.id!));
        const visiblePackages = new Set([...KOTLIN_DEFAULT_PACKAGES, file.packageName.replace(/\./g, "/"),
            ...file.imports.filter(i => i.star).map(i => i.name.replace(/\./g, "/"))]);
        const imported = new Set(file.imports.filter(i => !i.star).map(i => i.name));
        const out: FoundMember[] = [];
        const seen = new Set<string>();
        const consider = (m: PackageMember, actual: KType) => {
            const receiver = m.receiver!;
            const params = new Set(m.typeParams.map(p => p.name));
            const bindings = new Map<string, KType>();
            if (receiver.param) {
                const bounds = m.typeParams.find(p => p.name === receiver.param)?.bounds ?? [];
                if (!bounds.every(b => !b.id || b.id === "kotlin/Any" || ids.has(b.id))) { return; }
                bindings.set(receiver.param, { ...type, nullable: false });
            } else {
                if (!argumentsCompatible(receiver, actual, (a, b) => this.isSubclass(a, b))) { return; }
                unify(receiver, actual, params, bindings);
            }
            const s = bindOwnTypeParams(m, bindings);
            const key = memberKey(s);
            if (seen.has(key)) { return; }
            const isVisible = visiblePackages.has(m.pkg) || imported.has(`${m.pkg.replace(/\//g, ".")}.${m.name}`);
            if (!isVisible && receiver.param) { return; }
            seen.add(key);
            out.push({ ...s, inherited: false, extension: true, importName: isVisible ? undefined : `${m.pkg.replace(/\//g, ".")}.${m.name}` });
        };
        const decls = this.decls();
        for (const t of closure) {
            for (const m of decls.extensions.get(t.id!) ?? []) { consider(m, t); }
        }
        for (const m of decls.extensions.get("*") ?? []) { consider(m, type); }
        return out;
    }

    /** Top-level functions and properties whose name passes `accept`, and whether the file sees them without an import. */
    topLevelMatching(file: FileContext, accept: (name: string) => boolean): Array<{ member: PackageMember; visible: boolean }> {
        const pkg = file.packageName.replace(/\./g, "/");
        const stars = new Set(file.imports.filter(i => i.star).map(i => i.name.replace(/\./g, "/")));
        const explicit = new Set(file.imports.filter(i => !i.star).map(i => i.name));
        const out: Array<{ member: PackageMember; visible: boolean }> = [];
        for (const [name, members] of this.decls().topLevel) {
            if (!accept(name)) { continue; }
            for (const m of members) {
                const visible = m.pkg === pkg || KOTLIN_DEFAULT_PACKAGES.includes(m.pkg) || stars.has(m.pkg) || explicit.has(`${m.pkg.replace(/\//g, ".")}.${name}`);
                out.push({ member: m, visible });
            }
        }
        return out;
    }

    /** A class Kotlin code can name: not a file facade (`FooKt`), and public in its Kotlin metadata / class flags. */
    isUsableClass(id: string): boolean {
        let ok = this.usable.get(id);
        if (ok !== undefined) { return ok; }
        const simple = id.slice(id.lastIndexOf("/") + 1);
        ok = !/Kt(?:__\w+)?$/.test(simple);
        if (ok && !this.builtinClasses().has(id) && !this.decls().aliases.has(id) && !this.sources?.exists(id)) {
            const binary = classIdToBinary(id);
            const info = this.index.classInfo(binary);
            if (info?.metadata) {
                let cls: KClass | undefined;
                try { cls = info.metadata.kind === 1 ? decodeMetadata(info.metadata)?.cls : undefined; } catch { cls = undefined; }
                ok = !!cls && visible(cls.visibility, this.index.isProject(binary));
            } else if (info) {
                ok = (info.access & ACC_PUBLIC) !== 0 && !(info.access & ACC_SYNTHETIC);
            }
        }
        this.usable.set(id, ok);
        return ok;
    }

    /** Classes usable without a new import: imports, the file's package, Kotlin default imports (built-ins, aliases), `java.lang`. */
    visibleClasses(file: FileContext, accept: (simple: string) => boolean): string[] {
        const pkg = file.packageName.replace(/\./g, "/");
        const packages = [pkg, ...file.imports.filter(i => i.star).map(i => i.name.replace(/\./g, "/")), ...KOTLIN_DEFAULT_PACKAGES, "java/lang"];
        const bySimple = new Map<string, string>();
        const add = (id: string) => {
            const simple = id.slice(id.lastIndexOf("/") + 1);
            if (!simple.includes(".") && accept(simple) && !bySimple.has(simple) && this.isUsableClass(id)) { bySimple.set(simple, id); }
        };
        for (const imp of file.imports) {
            if (imp.star) { continue; }
            const id = this.resolveClass([imp.alias ?? imp.name.slice(imp.name.lastIndexOf(".") + 1)], file);
            if (id) { bySimple.set(imp.alias ?? id.slice(id.lastIndexOf("/") + 1).replace(/^.*\./, ""), id); }
        }
        const inPackages = (id: string) => packages.includes(id.slice(0, Math.max(0, id.lastIndexOf("/"))));
        for (const id of this.sources?.classIds() ?? []) { if (inPackages(id)) { add(id); } }
        for (const p of packages) { for (const simple of this.index.packageClasses(p)) { add(p ? `${p}/${simple}` : simple); } }
        for (const id of [...this.builtinClasses().keys(), ...this.decls().aliases.keys()]) { if (inPackages(id)) { add(id); } }
        return [...bySimple.values()];
    }

    /** Top-level functions/properties named `name`, visible ones first. */
    topLevel(name: string, file: FileContext): Member[] {
        const all = this.decls().topLevel.get(name) ?? [];
        const pkg = file.packageName.replace(/\./g, "/");
        const visibleIn = (m: PackageMember) =>
            m.pkg === pkg || KOTLIN_DEFAULT_PACKAGES.includes(m.pkg)
            || file.imports.some(i => i.name === `${m.pkg.replace(/\//g, ".")}${i.star ? "" : `.${name}`}`);
        return [...all.filter(visibleIn), ...all.filter(m => !visibleIn(m))];
    }
}

// ---------------------------------------------------------------------------------------------

function visible(v: Visibility, project: boolean): boolean {
    return v === "public" || (project && v === "internal");
}

function bind(typeParams: string[], t: KType): Map<string, KType> {
    const bindings = new Map<string, KType>();
    typeParams.forEach((p, i) => {
        const arg = t.args[i];
        if (arg) { bindings.set(p, arg.type ?? NULLABLE_ANY); }
    });
    return bindings;
}

function substituteMember<M extends Member>(m: M, bindings: Map<string, KType>): M {
    if (!bindings.size) { return m; }
    const own = new Set(m.typeParams.map(p => p.name));
    const effective = new Map([...bindings].filter(([k]) => !own.has(k)));
    if (!effective.size) { return m; }
    return {
        ...m,
        receiver: m.receiver && substitute(m.receiver, effective),
        params: m.params.map(p => ({ ...p, type: substitute(p.type, effective) })),
        returnType: substitute(m.returnType, effective),
    };
}

/** An extension with its own type parameters bound by the receiver: `Iterable<T>.map` on `List<String>` → T = String. */
function bindOwnTypeParams<M extends Member>(m: M, bindings: Map<string, KType>): M {
    if (!bindings.size) { return m; }
    return {
        ...m,
        typeParams: m.typeParams.filter(p => !bindings.has(p.name)),
        receiver: m.receiver && substitute(m.receiver, bindings),
        params: m.params.map(p => ({ ...p, type: substitute(p.type, bindings) })),
        returnType: substitute(m.returnType, bindings),
    };
}

function erasure(t: KType): string {
    return t.id ?? "*";
}

export function memberKey(m: Member): string {
    return m.kind === "property" ? `p:${m.name}` : `f:${m.name}(${m.params.map(p => erasure(p.type)).join(",")})`;
}

/** `Iterable<Int>.sum()` does not apply to `List<String>`; unknown or generic arguments are accepted. */
function argumentsCompatible(receiver: KType, actual: KType, isSubclass: (a: string, b: string) => boolean): boolean {
    return receiver.args.every((a, i) => {
        const expected = a.type;
        const got = actual.args[i]?.type;
        if (!expected?.id || !got?.id || a.variance === "*") { return true; }
        return a.variance === "in" ? isSubclass(expected.id, got.id) : isSubclass(got.id, expected.id);
    });
}

function functionMember(f: KFunction, owner: string, deprecated = false): Member {
    return {
        kind: "function", name: f.name, typeParams: f.typeParams, receiver: f.receiver, params: f.params, returnType: f.returnType,
        suspend: f.suspend, deprecated, owner,
    };
}

function propertyMember(p: KProperty, owner: string): Member {
    return { kind: "property", name: p.name, typeParams: p.typeParams, receiver: p.receiver, params: [], returnType: p.returnType, isVar: p.isVar, owner };
}

function javaMethodMember(m: MethodInfo, owner: string): Member {
    const varargs = (m.access & ACC_VARARGS) !== 0;
    return {
        kind: "function",
        name: m.name,
        typeParams: m.typeParams.map(name => ({ name, bounds: [] })),
        params: m.params.map((p, i) => {
            let type = fromJava(p.java);
            const vararg = varargs && i === m.params.length - 1;
            if (vararg) {
                const primitive = /^kotlin\/(\w+)Array$/.exec(type.id ?? "");
                type = primitive ? classType(`kotlin/${primitive[1]}`) : argType(type, 0);
            }
            return { name: p.name ?? "", type, vararg, hasDefault: false };
        }),
        returnType: fromJava(m.returnJava),
        deprecated: m.deprecated,
        owner,
    };
}

/**
 * The bytecode method of a Kotlin function, for `@Deprecated` (hidden functions are dropped). InlineOnly functions
 * are private in bytecode but still present.
 */
function jvmDeprecation(f: KFunction, methods: MethodInfo[]): [deprecated: boolean, hidden: boolean] {
    const name = f.jvmName ?? f.name;
    const arity = f.params.length + (f.receiver ? 1 : 0) + (f.suspend ? 1 : 0);
    const candidates = methods.filter(m => m.name === name && (f.jvmDesc ? m.descriptor === f.jvmDesc : m.params.length + (m.suspend ? 1 : 0) === arity));
    if (!candidates.length) { return [false, false]; }
    return [candidates.every(m => m.deprecated), candidates.every(m => m.hidden)];
}

/** Getters as synthetic properties; JDK methods replaced by Kotlin built-in members (`size()` → `size`) are hidden. */
function kotlinViewOfJava(members: Member[], supertypes: Set<string>, builtinFunctions: Set<string>, builtinProperties: Set<string>): Member[] {
    const out: Member[] = [];
    const setters = new Set(members.filter(m => m.kind === "function" && m.params.length === 1 && /^set[A-Z]/.test(m.name)).map(m => m.name.slice(3)));
    for (const m of members) {
        if (m.kind !== "function") { out.push(m); continue; }
        const renamedBy = RENAMED_BY_BUILTIN[m.name];
        if (NEVER_VISIBLE.has(m.name) || (renamedBy && supertypes.has(renamedBy)) || builtinFunctions.has(`${m.name}/${m.params.length}`)) { continue; }
        if (!m.params.length && builtinProperties.has(m.name)) { continue; }
        const property = !m.params.length && m.returnType.id !== "kotlin/Unit" ? syntheticPropertyName(m) : undefined;
        if (property && builtinProperties.has(property)) { continue; }
        out.push(m);
        if (property) {
            out.push({
                kind: "property", name: property, typeParams: [], params: [], returnType: m.returnType, owner: m.owner, javaName: m.name,
                isVar: setters.has(m.name.replace(/^(get|is)/, "")), deprecated: m.deprecated,
            });
        }
    }
    return out;
}

/** `getURL` → `url`, `getHttpCode` → `httpCode`, `isEmpty` (Boolean) → `isEmpty`. */
function syntheticPropertyName(m: Member): string | undefined {
    if (/^is[A-Z]/.test(m.name) && m.returnType.id === "kotlin/Boolean") { return m.name; }
    const match = /^get([A-Z].*)$/.exec(m.name);
    if (!match) { return undefined; }
    const name = match[1];
    const upper = /^[A-Z]+/.exec(name)![0];
    if (upper.length === 1) { return name[0].toLowerCase() + name.slice(1); }
    const run = upper.length === name.length ? upper.length : upper.length - 1;
    return name.slice(0, run).toLowerCase() + name.slice(run);
}

