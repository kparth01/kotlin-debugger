import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readZipEntry } from "../completion/archives";
import { child, children, compareVersions, mavenRepositoryRoot, parseXml, text, XmlElement } from "../completion/classpath";

export interface PomPlugin {
    groupId: string;
    artifactId: string;
    version?: string;
    /** `spring-boot` in `spring-boot:run`. */
    prefix: string;
    /** Goals from the plugin's descriptor; empty when the plugin is not in the local repository yet. */
    goals: string[];
}

/** One `pom.xml` as the Maven view shows it. Nothing is executed; parents come from disk or the local repository. */
export interface PomProject {
    file: string;
    dir: string;
    groupId: string;
    artifactId: string;
    version: string;
    /** `<name>`, else the artifact id. */
    name: string;
    packaging: string;
    /** `pom.xml` files of the `<modules>`. */
    modules: string[];
    /** Profile ids of this POM and its parents. */
    profiles: string[];
    /** Properties with the parents' merged in (the child wins). */
    properties: Map<string, string>;
}

interface RawPlugin { groupId: string; artifactId: string; version?: string }

interface RawPom {
    file: string;
    project: XmlElement;
    groupId?: string;
    artifactId: string;
    version?: string;
    parent?: { groupId: string; artifactId: string; version: string; relativePath: string };
    properties: Map<string, string>;
    plugins: RawPlugin[];
    managedPlugins: RawPlugin[];
}

export const LIFECYCLE_PHASES = ["clean", "validate", "compile", "test", "package", "verify", "install", "site", "deploy"];

const raw = new Map<string, { mtime: number; pom: RawPom | undefined }>();
const descriptors = new Map<string, { prefix?: string; goals: string[] }>();

function readRaw(file: string): RawPom | undefined {
    let mtime: number;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return undefined; }
    const cached = raw.get(file);
    if (cached?.mtime === mtime) { return cached.pom; }
    let pom: RawPom | undefined;
    try {
        const project = child(parseXml(fs.readFileSync(file, "utf8")), "project");
        if (project) {
            const parent = child(project, "parent");
            const relativePath = child(parent, "relativePath");
            const plugins = (el: XmlElement | undefined): RawPlugin[] => children(child(el, "plugins"), "plugin").map(p => ({
                groupId: text(p, "groupId") ?? "org.apache.maven.plugins", artifactId: text(p, "artifactId") ?? "", version: text(p, "version"),
            })).filter(p => p.artifactId);
            const build = child(project, "build");
            pom = {
                file, project,
                groupId: text(project, "groupId"),
                artifactId: text(project, "artifactId") ?? "",
                version: text(project, "version"),
                parent: parent && {
                    groupId: text(parent, "groupId") ?? "", artifactId: text(parent, "artifactId") ?? "", version: text(parent, "version") ?? "",
                    relativePath: relativePath ? relativePath.text.trim() : "../pom.xml",
                },
                properties: new Map((child(project, "properties")?.children ?? []).map(p => [p.name, p.text.trim()])),
                plugins: plugins(build),
                managedPlugins: plugins(child(build, "pluginManagement")),
            };
        }
    } catch {
        pom = undefined;
    }
    raw.set(file, { mtime, pom });
    return pom;
}

function repositoryFile(groupId: string, artifactId: string, version: string, extension: string): string {
    return path.join(mavenRepositoryRoot(), ...groupId.split("."), artifactId, version, `${artifactId}-${version}.${extension}`);
}

/** The POM and its parents, child first: `relativePath` on disk when it is that parent, else the local repository. */
function chain(file: string): RawPom[] {
    const poms: RawPom[] = [];
    for (let pom = readRaw(file); pom && poms.length < 12; ) {
        poms.push(pom);
        const parent = pom.parent;
        if (!parent) { break; }
        let next: RawPom | undefined;
        if (parent.relativePath) {
            let local = path.resolve(path.dirname(pom.file), parent.relativePath);
            if (!local.endsWith(".xml")) { local = path.join(local, "pom.xml"); }
            const candidate = readRaw(local);
            if (candidate && candidate.artifactId === parent.artifactId && (candidate.groupId ?? candidate.parent?.groupId) === parent.groupId) { next = candidate; }
        }
        pom = next ?? readRaw(repositoryFile(parent.groupId, parent.artifactId, parent.version, "pom"));
    }
    return poms;
}

function interpolate(value: string | undefined, properties: Map<string, string>): string | undefined {
    let result = value;
    for (let i = 0; result && i < 10 && result.includes("${"); i++) {
        const next = result.replace(/\$\{([^}]+)\}/g, (all, name: string) => properties.get(name) ?? all);
        if (next === result) { break; }
        result = next;
    }
    return result;
}

/** Reads a `pom.xml`; `undefined` when it is missing or is not a Maven project. */
export function readProject(file: string): PomProject | undefined {
    const poms = chain(file);
    const own = poms[0];
    if (!own) { return undefined; }
    const properties = new Map<string, string>();
    for (const pom of [...poms].reverse()) { pom.properties.forEach((value, name) => properties.set(name, value)); }
    const groupId = poms.map(p => p.groupId).find(Boolean) ?? "";
    const version = poms.map(p => p.version).find(Boolean) ?? "";
    for (const prefix of ["project", "pom"]) {
        properties.set(`${prefix}.groupId`, groupId);
        properties.set(`${prefix}.artifactId`, own.artifactId);
        properties.set(`${prefix}.version`, version);
    }
    properties.forEach((value, name) => properties.set(name, interpolate(value, properties) ?? value));
    const dir = path.dirname(file);
    return {
        file, dir, groupId, version,
        artifactId: own.artifactId,
        name: interpolate(text(own.project, "name"), properties) || own.artifactId || path.basename(dir),
        packaging: text(own.project, "packaging") ?? "jar",
        modules: children(child(own.project, "modules"), "module").map(m => {
            const target = path.resolve(dir, m.text.trim());
            return target.endsWith(".xml") ? target : path.join(target, "pom.xml");
        }).filter(f => fs.existsSync(f)),
        profiles: [...new Set(poms.flatMap(p => children(child(p.project, "profiles"), "profile").map(x => text(x, "id") ?? "").filter(Boolean)))],
        properties,
    };
}

/** Profile ids of `~/.m2/settings.xml`. */
export function settingsProfiles(): string[] {
    try {
        const settings = child(parseXml(fs.readFileSync(path.join(os.homedir(), ".m2", "settings.xml"), "utf8")), "settings");
        return children(child(settings, "profiles"), "profile").map(p => text(p, "id") ?? "").filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * The plugins declared in `<build><plugins>` of the POM and its parents, with the goals each plugin's descriptor
 * (`META-INF/maven/plugin.xml` in its jar in the local repository) lists.
 */
export function projectPlugins(project: PomProject): PomPlugin[] {
    const poms = chain(project.file);
    const managed = poms.flatMap(p => p.managedPlugins);
    const plugins = new Map<string, PomPlugin>();
    for (const declared of poms.flatMap(p => p.plugins)) {
        const key = `${declared.groupId}:${declared.artifactId}`;
        if (plugins.has(key)) { continue; }
        const stated = declared.version ?? managed.find(m => m.groupId === declared.groupId && m.artifactId === declared.artifactId)?.version;
        let version = interpolate(stated, project.properties);
        if (!version || version.includes("${")) {
            version = localVersions(declared.groupId, declared.artifactId).pop();
        }
        const descriptor = version ? pluginDescriptor(repositoryFile(declared.groupId, declared.artifactId, version, "jar")) : undefined;
        plugins.set(key, {
            groupId: declared.groupId, artifactId: declared.artifactId, version,
            prefix: descriptor?.prefix ?? defaultPrefix(declared.artifactId),
            goals: descriptor?.goals ?? [],
        });
    }
    return [...plugins.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function localVersions(groupId: string, artifactId: string): string[] {
    try {
        const dir = path.join(mavenRepositoryRoot(), ...groupId.split("."), artifactId);
        return fs.readdirSync(dir).filter(v => fs.existsSync(path.join(dir, v, `${artifactId}-${v}.jar`))).sort(compareVersions);
    } catch {
        return [];
    }
}

/** `maven-surefire-plugin` → `surefire`, `spring-boot-maven-plugin` → `spring-boot` (Maven's own convention). */
export function defaultPrefix(artifactId: string): string {
    return artifactId.replace(/^maven-(.+)-plugin$/, "$1").replace(/-maven-plugin$/, "").replace(/-plugin$/, "");
}

/** Goal prefix and goals of a plugin jar; `undefined` when the jar is missing or has no descriptor. */
export function pluginDescriptor(jar: string): { prefix?: string; goals: string[] } | undefined {
    const cached = descriptors.get(jar);
    if (cached) { return cached; }
    try {
        const xml = readZipEntry(jar, "META-INF/maven/plugin.xml");
        if (!xml) { return undefined; }
        const plugin = child(parseXml(xml.toString("utf8")), "plugin");
        const descriptor = {
            prefix: text(plugin, "goalPrefix"),
            goals: children(child(plugin, "mojos"), "mojo").map(m => text(m, "goal") ?? "").filter(Boolean).sort(),
        };
        descriptors.set(jar, descriptor);
        return descriptor;
    } catch {
        return undefined;
    }
}

/** `group:artifact:version` of a jar in the local repository; `undefined` for other paths. */
export function coordinates(jar: string): { groupId: string; artifactId: string; version: string } | undefined {
    const relative = path.relative(mavenRepositoryRoot(), jar);
    if (relative.startsWith("..") || path.isAbsolute(relative)) { return undefined; }
    const parts = relative.split(path.sep);
    if (parts.length < 4) { return undefined; }
    return { groupId: parts.slice(0, -3).join("."), artifactId: parts[parts.length - 3], version: parts[parts.length - 2] };
}
