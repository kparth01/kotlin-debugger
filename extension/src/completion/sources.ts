import * as fs from "fs";
import * as path from "path";
import { parseFileContext } from "./classIndex";
import { Inference, SourceClass, SourceDeclarations, SourceMember, SourceParam } from "./inference";
import { KParam } from "./kotlinMetadata";
import { Member, PackageMember, SourceClassModel, SourceProvider, TypeSystem } from "./typeSystem";
import { ANY, classType, KType } from "./types";

interface ParsedFile { inference: Inference; declarations: SourceDeclarations; pkg: string }

const SKIPPED_DIRS = new Set(["node_modules", ".git", "target", "build", "out", "bin", "dist", ".gradle", ".idea", ".vscode"]);
const MAX_FILES = 5000;
const MAX_FILE_SIZE = 1_000_000;

/** `.kt` files of a project, without build output and tool directories. */
export function kotlinSourceFiles(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 20 || files.length >= MAX_FILES) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (!SKIPPED_DIRS.has(e.name) && !e.name.startsWith(".")) { walk(path.join(dir, e.name), depth + 1); }
            } else if (e.name.endsWith(".kt") && files.length < MAX_FILES) {
                files.push(path.join(dir, e.name));
            }
        }
    };
    walk(root, 0);
    return files;
}

export function readSource(file: string): string | undefined {
    try {
        return fs.statSync(file).size <= MAX_FILE_SIZE ? fs.readFileSync(file, "utf8") : undefined;
    } catch {
        return undefined;
    }
}

/** Declarations of the project's Kotlin files (editor text when open), parsed on demand. */
export class ProjectSources implements SourceProvider {
    private readonly texts = new Map<string, string>();
    private readonly parsed = new Map<string, ParsedFile>();
    private classes?: Map<string, { file: ParsedFile; cls: SourceClass }>;
    private types?: TypeSystem;

    constructor(private readonly hasPackage: (path: string) => boolean) {}

    attach(types: TypeSystem): void { this.types = types; }

    /** Sets (or removes, with `undefined`) a file's text; true when something changed. */
    set(file: string, text: string | undefined): boolean {
        if (this.texts.get(file) === text) { return false; }
        if (text === undefined) { this.texts.delete(file); } else { this.texts.set(file, text); }
        this.parsed.delete(file);
        this.classes = undefined;
        return true;
    }

    private file(file: string): ParsedFile {
        let parsed = this.parsed.get(file);
        if (!parsed) {
            const text = this.texts.get(file) ?? "";
            const context = parseFileContext(text);
            const inference = new Inference(text, context, this.types!, this.hasPackage);
            let declarations: SourceDeclarations;
            try { declarations = inference.declarations(); } catch { declarations = { classes: [], topLevel: [] }; }
            parsed = { inference, declarations, pkg: context.packageName.replace(/\./g, "/") };
            this.parsed.set(file, parsed);
        }
        return parsed;
    }

    private index(): Map<string, { file: ParsedFile; cls: SourceClass }> {
        if (!this.classes) {
            this.classes = new Map();
            for (const file of this.texts.keys()) {
                const parsed = this.file(file);
                for (const cls of parsed.declarations.classes) {
                    if (!this.classes.has(cls.id)) { this.classes.set(cls.id, { file: parsed, cls }); }
                }
            }
        }
        return this.classes;
    }

    exists(id: string): boolean { return this.index().has(id); }

    classIds(): string[] { return [...this.index().keys()]; }

    classModel(id: string): SourceClassModel | undefined {
        const entry = this.index().get(id);
        if (!entry) { return undefined; }
        const { file, cls } = entry;
        const inference = file.inference;
        const self = classType(id, cls.typeParams.map(p => ({ variance: "", type: { param: p, args: [], nullable: false } })));
        const members: SourceClassModel["members"] = cls.members.filter(m => m.visible).map(m => this.member(inference, m, id));
        const constructor = (cls.primaryConstructor ?? []).map(p => this.param(inference, p));
        if (cls.data) {
            const properties = constructor.filter(p => cls.members.some(m => m.kind === "property" && m.name === p.name));
            properties.forEach((p, i) => members.push({ kind: "function", name: `component${i + 1}`, typeParams: [], params: [], returnType: p.type, owner: id }));
            members.push({ kind: "function", name: "copy", typeParams: [], params: properties.map(p => ({ ...p, hasDefault: true })), returnType: self, owner: id });
        }
        const statics: Member[] = cls.enumEntries.map(name => ({ kind: "property", name, typeParams: [], params: [], returnType: classType(id), owner: id }));
        const supertypes = cls.supertypes.map(r => inference.typeAt(r[0], r[1])).filter((t): t is KType => !!t);
        if (cls.kind === "enum") {
            supertypes.push(classType("kotlin/Enum", [{ variance: "", type: self }]));
            statics.push(
                { kind: "property", name: "entries", typeParams: [], params: [], returnType: classType("kotlin/enums/EnumEntries", [{ variance: "", type: self }]), owner: id },
                { kind: "function", name: "values", typeParams: [], params: [], returnType: classType("kotlin/Array", [{ variance: "", type: self }]), owner: id },
                { kind: "function", name: "valueOf", typeParams: [], params: [{ name: "value", type: classType("kotlin/String"), vararg: false, hasDefault: false }], returnType: self, owner: id },
            );
        }
        return {
            kind: cls.kind, typeParams: cls.typeParams, supertypes, members, statics,
            constructors: cls.primaryConstructor ? [constructor] : [], companion: cls.companion,
        };
    }

    packageMembers(): PackageMember[] {
        const out: PackageMember[] = [];
        for (const file of this.texts.keys()) {
            const parsed = this.file(file);
            for (const m of parsed.declarations.topLevel) {
                if (!m.visible) { continue; }
                const member = this.member(parsed.inference, m, parsed.pkg);
                out.push({ ...member, returnType: member.returnType ?? ANY, pkg: parsed.pkg });
            }
        }
        return out;
    }

    private member(inference: Inference, m: SourceMember, owner: string): Omit<Member, "returnType"> & { returnType?: KType } {
        let returnType: KType | undefined;
        try {
            returnType = m.type ? inference.typeAt(m.type[0], m.type[1])
                : m.lazy !== undefined ? inference.lazyTypeAt(m.lazy)
                    : m.body ? inference.valueTypeAt(m.body[0], m.body[1])
                        : m.kind === "function" ? classType("kotlin/Unit") : undefined;
        } catch {
            returnType = undefined;
        }
        return {
            kind: m.kind,
            name: m.name,
            typeParams: m.typeParams.map(name => ({ name, bounds: [] })),
            receiver: m.receiver && inference.typeAt(m.receiver[0], m.receiver[1]),
            params: m.params.map(p => this.param(inference, p)),
            returnType,
            isVar: m.isVar,
            suspend: m.suspend,
            owner,
        };
    }

    private param(inference: Inference, p: SourceParam): KParam {
        return { name: p.name, type: (p.type && inference.typeAt(p.type[0], p.type[1])) ?? ANY, vararg: p.vararg, hasDefault: p.hasDefault };
    }
}
