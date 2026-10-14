import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ProjectClasspath {
    buildTool: "maven" | "gradle" | "none";
    /** Jars and class directories, in classpath order. */
    entries: string[];
    /** Dependencies that are not in the local repository yet. */
    missing: string[];
}

const GRADLE_BUILD_FILES = ["build.gradle.kts", "build.gradle"];

/** The nearest directory from `dir` up to `stop` that has a Maven or Gradle build file. */
export function findBuildRoot(dir: string, stop: string): string | undefined {
    for (let d = dir; ; d = path.dirname(d)) {
        if (["pom.xml", ...GRADLE_BUILD_FILES].some(f => fs.existsSync(path.join(d, f)))) { return d; }
        if (d === stop || path.dirname(d) === d) { return undefined; }
    }
}

/** Resolves the compile/test classpath from build files and the local Maven/Gradle caches (no build tool is run). */
export function resolveClasspath(root: string): ProjectClasspath {
    if (fs.existsSync(path.join(root, "pom.xml"))) {
        return new Resolver([mavenRepository(), gradleCache()]).maven(root);
    }
    if (GRADLE_BUILD_FILES.some(f => fs.existsSync(path.join(root, f)))) {
        return new Resolver([gradleCache(), mavenRepository()]).gradle(root);
    }
    const jars = ["lib", "libs"].flatMap(d => list(path.join(root, d)).filter(f => f.endsWith(".jar")).map(f => path.join(root, d, f)));
    return { buildTool: "none", entries: [...dirs(root, ["target/classes", "build/classes/kotlin/main", "build/classes/java/main", "out"]), ...jars], missing: [] };
}

/** `lib/modules` (JDK 9+) or `rt.jar` (JDK 8) of the first JDK found; nothing is executed. */
export function findJdkClasses(configuredHome?: string): string | undefined {
    for (const home of [configuredHome, process.env.JAVA_HOME, javaHomeOnPath(), ...installedJdks()]) {
        if (!home) { continue; }
        const file = ["lib/modules", "Contents/Home/lib/modules", "jre/lib/rt.jar", "lib/rt.jar"]
            .map(f => path.join(home, f)).find(f => fs.existsSync(f));
        if (file) { return file; }
    }
    return undefined;
}

function javaHomeOnPath(): string | undefined {
    const exe = process.platform === "win32" ? "java.exe" : "java";
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        const file = dir && path.join(dir, exe);
        if (file && fs.existsSync(file)) {
            try { return path.dirname(path.dirname(fs.realpathSync(file))); } catch { /* broken link */ }
        }
    }
    return undefined;
}

function installedJdks(): string[] {
    const newestFirst = (root: string, suffix = "") =>
        list(root).sort(compareVersions).reverse().map(d => path.join(root, d, suffix));
    if (process.platform === "darwin") {
        return [
            ...newestFirst("/Library/Java/JavaVirtualMachines", "Contents/Home"),
            ...newestFirst(path.join(os.homedir(), "Library/Java/JavaVirtualMachines"), "Contents/Home"),
            ...["/opt/homebrew/opt", "/usr/local/opt"].flatMap(r =>
                list(r).filter(d => d.startsWith("openjdk")).map(d => path.join(r, d, "libexec/openjdk.jdk/Contents/Home"))),
        ];
    }
    if (process.platform === "win32") {
        const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
        return ["Java", "Eclipse Adoptium", "Microsoft", "Zulu"].flatMap(v => newestFirst(path.join(programFiles, v)));
    }
    return newestFirst("/usr/lib/jvm");
}

// ---------------------------------------------------------------------------------------------
// Repositories

interface Repository {
    file(groupId: string, artifactId: string, version: string, extension: string, classifier?: string): string | undefined;
    versions(groupId: string, artifactId: string): string[];
}

function mavenRepository(): Repository {
    const settings = path.join(os.homedir(), ".m2", "settings.xml");
    const configured = fs.existsSync(settings)
        ? /<localRepository>\s*([^<]+?)\s*<\/localRepository>/.exec(fs.readFileSync(settings, "utf8"))?.[1]
        : undefined;
    const root = configured?.replace(/\$\{user\.home\}/g, os.homedir()) ?? path.join(os.homedir(), ".m2", "repository");
    const dir = (g: string, a: string) => path.join(root, ...g.split("."), a);
    return {
        file: (g, a, v, ext, classifier) => existing(path.join(dir(g, a), v, `${a}-${v}${classifier ? `-${classifier}` : ""}.${ext}`)),
        versions: (g, a) => list(dir(g, a)),
    };
}

/** `~/.gradle/caches/modules-2/files-2.1/<group>/<artifact>/<version>/<sha1>/<file>` */
function gradleCache(): Repository {
    const root = path.join(process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), ".gradle"), "caches", "modules-2", "files-2.1");
    return {
        file: (g, a, v, ext, classifier) => {
            const name = `${a}-${v}${classifier ? `-${classifier}` : ""}.${ext}`;
            const versionDir = path.join(root, g, a, v);
            return list(versionDir).map(hash => path.join(versionDir, hash, name)).find(f => fs.existsSync(f));
        },
        versions: (g, a) => list(path.join(root, g, a)),
    };
}

// ---------------------------------------------------------------------------------------------
// POM model: parent inheritance, property interpolation, dependency management and BOM imports

interface Dependency {
    groupId: string;
    artifactId: string;
    version?: string;
    scope?: string;
    type?: string;
    classifier?: string;
    optional: boolean;
    /** `groupId:artifactId`, either may be `*`. */
    exclusions: string[];
}

interface RawPom {
    file: string;
    groupId?: string;
    artifactId: string;
    version?: string;
    parent?: { groupId: string; artifactId: string; version: string; relativePath: string };
    properties: Map<string, string>;
    managed: Dependency[];
    dependencies: Dependency[];
    modules: string[];
}

interface Model {
    groupId: string;
    artifactId: string;
    managed: Map<string, Dependency>;
    dependencies: Dependency[];
}

const key = (d: { groupId: string; artifactId: string; classifier?: string }) =>
    `${d.groupId}:${d.artifactId}${d.classifier ? `:${d.classifier}` : ""}`;

class Resolver {
    private readonly poms = new Map<string, RawPom | undefined>();
    private readonly models = new Map<string, Model | undefined>();

    constructor(private readonly repositories: Repository[]) {}

    maven(root: string): ProjectClasspath {
        const pomFile = path.join(root, "pom.xml");
        const entries = dirs(root, ["target/classes", "target/test-classes"]);
        const missing: string[] = [];
        const model = this.model(pomFile);
        if (model) {
            this.resolve(model.dependencies, model.managed, this.reactor(pomFile), new Set([key(model)]), entries, missing);
        }
        return { buildTool: "maven", entries, missing };
    }

    gradle(root: string): ProjectClasspath {
        let settingsRoot = root;
        for (let d = root, i = 0; i < 5 && path.dirname(d) !== d; d = path.dirname(d), i++) {
            if (["settings.gradle.kts", "settings.gradle"].some(f => fs.existsSync(path.join(d, f)))) { settingsRoot = d; break; }
        }
        const script = GRADLE_BUILD_FILES.map(f => read(path.join(root, f))).join("\n");
        const declared = gradleDependencies(script, read(path.join(settingsRoot, "gradle", "libs.versions.toml")));
        const projects = [root, ...[...script.matchAll(/project\(\s*(?:path\s*=\s*)?["']:([\w:.-]+)["']/g)]
            .map(m => path.join(settingsRoot, ...m[1].split(":")))];
        const entries = projects.flatMap(p => dirs(p, ["build/classes/kotlin/main", "build/classes/java/main", "build/classes/kotlin/test", "build/classes/java/test"]));
        const missing: string[] = [];
        this.resolve(declared, new Map(), new Map(), new Set(), entries, missing);
        return { buildTool: "gradle", entries, missing };
    }

    /** Breadth-first, nearest declaration wins (Maven mediation); `managed` overrides transitive versions. */
    private resolve(
        roots: Dependency[], managed: Map<string, Dependency>, reactor: Map<string, string>,
        seen: Set<string>, entries: string[], missing: string[],
    ) {
        let level = roots.filter(d => d.scope !== "system" && d.scope !== "import").map(d => ({ d, exclusions: d.exclusions }));
        for (let depth = 0; level.length; depth++) {
            const next: typeof level = [];
            for (const { d, exclusions } of level) {
                const k = key(d);
                if (seen.has(k)) { continue; }
                seen.add(k);
                let model: Model | undefined;
                const module = reactor.get(`${d.groupId}:${d.artifactId}`);
                if (module) {
                    entries.push(...dirs(module, ["target/classes"]));
                    model = this.model(path.join(module, "pom.xml"));
                } else {
                    const version = this.version(d.groupId, d.artifactId, (depth > 0 ? managed.get(k)?.version : undefined) ?? d.version);
                    if (!version) { missing.push(`${d.groupId}:${d.artifactId}`); continue; }
                    if (d.type !== "pom") {
                        const jar = this.find(d.groupId, d.artifactId, version, "jar", d.type === "test-jar" ? "tests" : d.classifier);
                        if (jar) { entries.push(jar); } else { missing.push(`${d.groupId}:${d.artifactId}:${version}`); }
                    }
                    const pom = this.find(d.groupId, d.artifactId, version, "pom");
                    model = pom ? this.model(pom) : undefined;
                }
                for (const t of model?.dependencies ?? []) {
                    if (t.optional || (t.scope && t.scope !== "compile" && t.scope !== "runtime")) { continue; }
                    if (exclusions.some(e => excludes(e, t))) { continue; }
                    next.push({ d: t, exclusions: [...exclusions, ...t.exclusions] });
                }
            }
            level = next;
        }
    }

    /** A concrete version; missing, unresolved or range versions use the newest one available locally. */
    private version(groupId: string, artifactId: string, version: string | undefined): string | undefined {
        if (version && !version.includes("${") && !/^[[(]/.test(version)) { return version; }
        return this.repositories.flatMap(r => r.versions(groupId, artifactId))
            .filter(v => this.find(groupId, artifactId, v, "pom") || this.find(groupId, artifactId, v, "jar"))
            .sort(compareVersions).pop();
    }

    private find(groupId: string, artifactId: string, version: string, extension: string, classifier?: string): string | undefined {
        for (const r of this.repositories) {
            const f = r.file(groupId, artifactId, version, extension, classifier);
            if (f) { return f; }
        }
        return undefined;
    }

    private pom(file: string): RawPom | undefined {
        if (!this.poms.has(file)) {
            let pom: RawPom | undefined;
            try { pom = parsePom(file); } catch { pom = undefined; }
            this.poms.set(file, pom);
        }
        return this.poms.get(file);
    }

    private localParent(pom: RawPom): string | undefined {
        const parent = pom.parent;
        if (!parent?.relativePath) { return undefined; }
        let file = path.resolve(path.dirname(pom.file), parent.relativePath);
        if (!file.endsWith(".xml")) { file = path.join(file, "pom.xml"); }
        const local = fs.existsSync(file) ? this.pom(file) : undefined;
        return local && local.artifactId === parent.artifactId && (local.groupId ?? local.parent?.groupId) === parent.groupId ? file : undefined;
    }

    /** Modules of the multi-module build that contains `pomFile`: `groupId:artifactId` → directory. */
    private reactor(pomFile: string): Map<string, string> {
        let top = pomFile;
        for (let i = 0, p = this.pom(top); p && i < 10; i++) {
            const parent = this.localParent(p);
            if (!parent) { break; }
            top = parent;
            p = this.pom(top);
        }
        const modules = new Map<string, string>();
        const visit = (file: string, depth: number) => {
            const pom = this.pom(file);
            if (!pom || depth > 6) { return; }
            modules.set(`${pom.groupId ?? pom.parent?.groupId}:${pom.artifactId}`, path.dirname(file));
            for (const m of pom.modules) {
                const child = path.join(path.dirname(file), m);
                visit(child.endsWith(".xml") ? child : path.join(child, "pom.xml"), depth + 1);
            }
        };
        visit(top, 0);
        return modules;
    }

    private model(file: string): Model | undefined {
        if (!this.models.has(file)) {
            this.models.set(file, undefined);
            this.models.set(file, this.buildModel(file));
        }
        return this.models.get(file);
    }

    private buildModel(file: string): Model | undefined {
        const chain: RawPom[] = [];
        for (let f: string | undefined = file; f && chain.length < 20;) {
            const pom = this.pom(f);
            if (!pom) { break; }
            chain.push(pom);
            const parent = pom.parent;
            f = parent && (this.localParent(pom) ?? this.find(parent.groupId, parent.artifactId, parent.version, "pom"));
        }
        const self = chain[0];
        if (!self) { return undefined; }
        const groupId = self.groupId ?? self.parent?.groupId ?? "";
        const version = self.version ?? self.parent?.version ?? "";
        // Inheritance first, then interpolation with the child's properties (a child can override versions of its parent).
        const props = new Map<string, string>();
        for (const pom of [...chain].reverse()) { for (const [k, v] of pom.properties) { props.set(k, v); } }
        const builtins: Array<[string, string]> = [
            ["project.groupId", groupId], ["project.artifactId", self.artifactId], ["project.version", version],
            ["pom.version", version], ["version", version], ["project.parent.version", self.parent?.version ?? ""],
            ["project.parent.groupId", self.parent?.groupId ?? ""], ["project.basedir", path.dirname(file)], ["basedir", path.dirname(file)],
        ];
        for (const [k, v] of builtins) { props.set(k, v); }
        const interpolate = (s: string | undefined) => {
            for (let i = 0; s?.includes("${") && i < 10; i++) {
                const next: string = s.replace(/\$\{([^}]+)\}/g, (m, name: string) =>
                    props.get(name) ?? (name.startsWith("env.") ? process.env[name.slice(4)] : undefined) ?? m);
                if (next === s) { break; }
                s = next;
            }
            return s;
        };
        const resolved = (d: Dependency): Dependency => ({
            ...d, groupId: interpolate(d.groupId)!, artifactId: interpolate(d.artifactId)!, version: interpolate(d.version),
            scope: interpolate(d.scope), type: interpolate(d.type), classifier: interpolate(d.classifier),
        });

        const managed = new Map<string, Dependency>();
        const imports: Dependency[] = [];
        for (const pom of chain) {
            for (const raw of pom.managed) {
                const d = resolved(raw);
                if (d.scope === "import") { imports.push(d); } else if (!managed.has(key(d))) { managed.set(key(d), d); }
            }
        }
        for (const d of imports) {
            const bom = d.version ? this.find(d.groupId, d.artifactId, d.version, "pom") : undefined;
            const bomManaged = bom ? this.model(bom)?.managed : undefined;
            for (const [k, v] of bomManaged ?? new Map<string, Dependency>()) {
                if (!managed.has(k)) { managed.set(k, v); }
            }
        }
        const dependencies = new Map<string, Dependency>();
        for (const pom of chain) {
            for (const raw of pom.dependencies) {
                const d = resolved(raw);
                if (dependencies.has(key(d))) { continue; }
                const m = managed.get(key(d));
                dependencies.set(key(d), {
                    ...d, version: d.version ?? m?.version, scope: d.scope ?? m?.scope, exclusions: [...d.exclusions, ...m?.exclusions ?? []],
                });
            }
        }
        return { groupId, artifactId: self.artifactId, managed, dependencies: [...dependencies.values()] };
    }
}

function excludes(exclusion: string, d: Dependency): boolean {
    const [g, a] = exclusion.split(":");
    return (g === "*" || g === d.groupId) && (a === "*" || a === d.artifactId);
}

function parsePom(file: string): RawPom {
    const project = child(parseXml(fs.readFileSync(file, "utf8")), "project");
    if (!project) { throw new Error("no <project>"); }
    const dependencies = (el: XmlElement | undefined): Dependency[] =>
        children(child(el, "dependencies"), "dependency").map(d => ({
            groupId: text(d, "groupId") ?? "",
            artifactId: text(d, "artifactId") ?? "",
            version: text(d, "version"),
            scope: text(d, "scope"),
            type: text(d, "type"),
            classifier: text(d, "classifier"),
            optional: text(d, "optional") === "true",
            exclusions: children(child(d, "exclusions"), "exclusion").map(e => `${text(e, "groupId") ?? "*"}:${text(e, "artifactId") ?? "*"}`),
        }));
    const parent = child(project, "parent");
    const relativePath = child(parent, "relativePath");
    return {
        file,
        groupId: text(project, "groupId"),
        artifactId: text(project, "artifactId") ?? "",
        version: text(project, "version"),
        parent: parent && {
            groupId: text(parent, "groupId") ?? "",
            artifactId: text(parent, "artifactId") ?? "",
            version: text(parent, "version") ?? "",
            relativePath: relativePath ? relativePath.text.trim() : "../pom.xml",
        },
        properties: new Map((child(project, "properties")?.children ?? []).map(p => [p.name, p.text.trim()])),
        managed: dependencies(child(project, "dependencyManagement")),
        dependencies: dependencies(project),
        modules: children(child(project, "modules"), "module").map(m => m.text.trim()),
    };
}

// ---------------------------------------------------------------------------------------------
// Gradle: declared coordinates (string notation, kotlin("x"), version catalog), resolved with the POMs in the caches

function gradleDependencies(script: string, catalog: string): Dependency[] {
    const dependency = (groupId: string, artifactId: string, version?: string): Dependency =>
        ({ groupId, artifactId, version, optional: false, exclusions: [] });
    const result: Dependency[] = [];
    for (const m of script.matchAll(/["']([\w.-]+):([\w.-]+)(?::([^:"'\s$]+))?(?::[\w.-]+)?["']/g)) {
        result.push(dependency(m[1], m[2], m[3]));
    }
    for (const m of script.matchAll(/\(\s*kotlin\(\s*["']([\w.-]+)["']\s*(?:,\s*["']([^"']+)["'])?\s*\)/g)) {
        result.push(dependency("org.jetbrains.kotlin", `kotlin-${m[1]}`, m[2]));
    }
    if (/\bkotlin\(|org\.jetbrains\.kotlin/.test(script)) { result.push(dependency("org.jetbrains.kotlin", "kotlin-stdlib")); }

    const versions = new Map<string, string>();
    let section = "";
    for (const raw of catalog.split("\n")) {
        const line = raw.replace(/#.*/, "").trim();
        const header = /^\[(.+)\]$/.exec(line);
        if (header) { section = header[1]; continue; }
        const entry = /^([\w.-]+)\s*=\s*(.+)$/.exec(line);
        if (!entry) { continue; }
        const value = entry[2];
        const field = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(value)?.[1];
        if (section === "versions") {
            const v = /^"([^"]+)"/.exec(value)?.[1] ?? field("strictly") ?? field("require") ?? field("prefer");
            if (v) { versions.set(entry[1], v); }
        } else if (section === "libraries") {
            const notation = /^"([^"]+)"$/.exec(value)?.[1];
            const [g, a, v] = notation ? notation.split(":") : field("module")?.split(":") ?? [field("group"), field("name")];
            const version = notation ? v : field("version") ?? versions.get(field("version\\.ref") ?? "");
            if (g && a) { result.push(dependency(g, a, version)); }
        }
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Minimal XML (enough for POM files: elements and text)

interface XmlElement { name: string; text: string; children: XmlElement[] }

function parseXml(xml: string): XmlElement {
    const root: XmlElement = { name: "", text: "", children: [] };
    const stack = [root];
    const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/[^>]*>|<([\w.:-]+)[^>]*?(\/?)>|([^<]+)/g;
    for (const m of xml.matchAll(token)) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) {
            top.text += m[1];
        } else if (m[2]) {
            const el: XmlElement = { name: m[2], text: "", children: [] };
            top.children.push(el);
            if (!m[3]) { stack.push(el); }
        } else if (m[4] !== undefined) {
            top.text += m[4].replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" })[e]!);
        } else if (m[0].startsWith("</") && stack.length > 1) {
            stack.pop();
        }
    }
    return root;
}

function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
    return el?.children.find(c => c.name === name);
}

function children(el: XmlElement | undefined, name: string): XmlElement[] {
    return el?.children.filter(c => c.name === name) ?? [];
}

function text(el: XmlElement | undefined, name: string): string | undefined {
    return child(el, name)?.text.trim() || undefined;
}

// ---------------------------------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
    const x = a.split(/[.\-_]/), y = b.split(/[.\-_]/);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const p = x[i] ?? "", q = y[i] ?? "";
        if (p === q) { continue; }
        const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
        if (pn && qn) {
            if (Number(p) !== Number(q)) { return Number(p) - Number(q); }
            continue;
        }
        // 1.0 < 1.0.1, but 1.0-RC1 < 1.0
        if (!p) { return qn ? -1 : 1; }
        if (!q) { return pn ? 1 : -1; }
        if (pn !== qn) { return pn ? 1 : -1; }
        return p < q ? -1 : 1;
    }
    return 0;
}

function list(dir: string): string[] {
    try { return fs.readdirSync(dir); } catch { return []; }
}

function read(file: string): string {
    try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function existing(file: string): string | undefined {
    return fs.existsSync(file) ? file : undefined;
}

function dirs(root: string, relative: string[]): string[] {
    return relative.map(r => path.join(root, r)).filter(d => {
        try { return fs.statSync(d).isDirectory(); } catch { return false; }
    });
}
