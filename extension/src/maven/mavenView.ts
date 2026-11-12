import * as net from "net";
import * as vscode from "vscode";
import { resolveClasspath } from "../completion/classpath";
import { debugSetup, findMaven, mavenInvocation, MavenOptions, splitGoals } from "./invocation";
import { jdkLabel, requiredJavaVersion } from "./jdks";
import { coordinates, LIFECYCLE_PHASES, PomPlugin, PomProject, projectPlugins, readProject, settingsProfiles } from "./pomModel";
import { ProjectJdk } from "./projectJdk";

/** What `activate()` returns for the Maven view: used by the end-to-end tests and other extensions. */
export interface MavenApi {
    /** Root projects of the workspace (modules are reached through `modules`). */
    projects(): Promise<PomProject[]>;
    plugins(pomFile: string): PomPlugin[];
    /** Runs goals with the Project JDK and resolves with Maven's exit code (`undefined` when it was not started). */
    run(pomFile: string, goals: string[], debug?: boolean): Promise<number | undefined>;
}

type Group = "lifecycle" | "plugins" | "dependencies" | "profiles" | "runs";

type Node =
    | { kind: "jdk"; folder?: vscode.WorkspaceFolder; single: boolean }
    | { kind: "options" }
    | { kind: "project"; project: PomProject; root: boolean }
    | { kind: "group"; project: PomProject; group: Group }
    | { kind: "plugin"; project: PomProject; plugin: PomPlugin }
    | { kind: "goal"; project: PomProject; goals: string[]; label: string }
    | { kind: "run"; project: PomProject; line: string }
    | { kind: "profile"; project: PomProject; id: string }
    | { kind: "info"; label: string; description?: string; tooltip?: string; icon?: string };

type Switches = Pick<MavenOptions, "offline" | "skipTests" | "updateSnapshots" | "debugOutput">;

const SWITCHES: Array<{ key: keyof Switches; label: string; detail: string }> = [
    { key: "offline", label: "Offline", detail: "-o: work without the network" },
    { key: "skipTests", label: "Skip tests", detail: "-DskipTests: compile the tests but do not run them" },
    { key: "updateSnapshots", label: "Update snapshots", detail: "-U: check remote repositories for newer snapshots" },
    { key: "debugOutput", label: "Debug output", detail: "-X: Maven's full debug log" },
];
const GROUPS: Record<Group, string> = { lifecycle: "Lifecycle", plugins: "Plugins", dependencies: "Dependencies", profiles: "Profiles", runs: "Run Configurations" };
const PROBLEM_MATCHERS = ["$kotlin-maven", "$kotlin-maven-legacy", "$javac-maven"];
const VIEW = "kotlinDebugger.maven";

export function registerMaven(context: vscode.ExtensionContext, output: vscode.OutputChannel, debugType: string): MavenApi {
    const jdks = new ProjectJdk();
    const maven = new MavenView(context, jdks, output, debugType);
    const view = vscode.window.createTreeView(VIEW, { treeDataProvider: maven, showCollapseAll: true });
    const poms = vscode.workspace.createFileSystemWatcher("**/pom.xml");
    poms.onDidCreate(() => maven.refreshSoon());
    poms.onDidChange(() => maven.refreshSoon());
    poms.onDidDelete(() => maven.refreshSoon());
    const command = (name: string, run: (...args: any[]) => unknown) => vscode.commands.registerCommand(name, run);
    context.subscriptions.push(
        jdks, view, poms, maven,
        view.onDidChangeCheckboxState(e => maven.profilesChecked(e.items as ReadonlyArray<[Node, vscode.TreeItemCheckboxState]>)),
        jdks.onDidChange(() => maven.changed()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => maven.refreshSoon()),
        vscode.window.onDidChangeActiveTextEditor(() => maven.updateStatus()),
        command("kotlinDebugger.selectProjectJdk", (arg?: Node | string) => maven.selectJdk(arg)),
        command("kotlinDebugger.maven.refresh", () => maven.refresh()),
        command("kotlinDebugger.maven.activate", (node: Node) => maven.activate(node)),
        command("kotlinDebugger.maven.runGoal", (node: Node) => maven.runNode(node, false)),
        command("kotlinDebugger.maven.debugGoal", (node: Node) => maven.runNode(node, true)),
        command("kotlinDebugger.maven.execute", (node?: Node) => maven.execute(node)),
        command("kotlinDebugger.maven.options", () => maven.chooseOptions()),
        command("kotlinDebugger.maven.addRun", (node?: Node) => maven.addRun(node)),
        command("kotlinDebugger.maven.removeRun", (node: Node) => maven.removeRun(node)),
        command("kotlinDebugger.maven.openPom", (node: Node) => maven.openPom(node)),
    );
    maven.refresh().catch(e => output.appendLine(`[maven] ${(e as Error).stack ?? e}`));
    return {
        projects: () => maven.refresh(),
        plugins: pomFile => { const project = readProject(pomFile); return project ? projectPlugins(project) : []; },
        run: async (pomFile, goals, debug) => {
            const project = readProject(pomFile);
            const execution = project && await maven.start(project, goals, !!debug);
            return execution ? maven.exitCode(execution) : undefined;
        },
    };
}

class MavenView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private roots: PomProject[] = [];
    private timer: NodeJS.Timeout | undefined;
    private lastClick: { node: Node; time: number } | undefined;
    /** `<pom>|<jdk home>` pairs the version warning was shown for. */
    private readonly warned = new Set<string>();

    constructor(
        private readonly context: vscode.ExtensionContext, private readonly jdks: ProjectJdk,
        private readonly output: vscode.OutputChannel, private readonly debugType: string,
    ) {}

    dispose(): void {
        clearTimeout(this.timer);
        this.emitter.dispose();
    }

    // ---- model

    /** Reads every `pom.xml` of the workspace; projects that are a module of another one hang below it. */
    async refresh(): Promise<PomProject[]> {
        const files = await vscode.workspace.findFiles("**/pom.xml", "**/{target,build,node_modules,out,dist,.git,.idea}/**", 500);
        const projects = files.map(f => readProject(f.fsPath)).filter((p): p is PomProject => !!p);
        const modules = new Set(projects.flatMap(p => p.modules));
        this.roots = projects.filter(p => !modules.has(p.file)).sort((a, b) => a.dir.localeCompare(b.dir));
        await vscode.commands.executeCommand("setContext", "kotlinDebugger.hasMavenProject", this.roots.length > 0);
        this.updateStatus();
        this.changed();
        return this.roots;
    }

    refreshSoon(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh().catch(() => undefined), 500);
    }

    changed(): void { this.emitter.fire(undefined); }

    updateStatus(): void {
        const editor = vscode.window.activeTextEditor?.document.uri;
        const inWorkspace = editor && vscode.workspace.getWorkspaceFolder(editor) ? editor : undefined;
        this.jdks.showStatus(inWorkspace ?? (this.roots[0] && vscode.Uri.file(this.roots[0].file)), this.roots.length > 0);
    }

    private state<T>(key: string, fallback: T): T { return this.context.workspaceState.get<T>(key, fallback); }

    private switches(): Switches {
        return { offline: false, skipTests: false, updateSnapshots: false, debugOutput: false, ...this.state<Partial<Switches>>("maven.options", {}) };
    }

    private perProject(key: string, project: PomProject): string[] {
        return this.state<Record<string, string[]>>(key, {})[project.dir] ?? [];
    }

    private async setPerProject(key: string, project: PomProject, values: string[]): Promise<void> {
        await this.context.workspaceState.update(key, { ...this.state<Record<string, string[]>>(key, {}), [project.dir]: values });
        this.changed();
    }

    private options(project: PomProject): MavenOptions {
        const known = new Set([...project.profiles, ...settingsProfiles()]);
        return {
            ...this.switches(),
            profiles: this.perProject("maven.profiles", project).filter(id => known.has(id)),
            extraArgs: vscode.workspace.getConfiguration("kotlinDebugger", vscode.Uri.file(project.file)).get<string[]>("maven.arguments", []),
        };
    }

    // ---- tree

    getChildren(node?: Node): Node[] {
        if (!node) {
            if (!this.roots.length) { return []; }
            const folders = [...new Set(this.roots.map(p => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p.file))))];
            const active = SWITCHES.some(s => this.switches()[s.key]);
            return [
                ...folders.map((folder): Node => ({ kind: "jdk", folder, single: folders.length === 1 })),
                ...(active ? [{ kind: "options" } as Node] : []),
                ...this.roots.map((project): Node => ({ kind: "project", project, root: true })),
            ];
        }
        switch (node.kind) {
            case "project": {
                const modules = node.project.modules.map(file => readProject(file)).filter((p): p is PomProject => !!p);
                return [
                    ...(Object.keys(GROUPS) as Group[]).map((group): Node => ({ kind: "group", project: node.project, group })),
                    ...modules.map((project): Node => ({ kind: "project", project, root: false })),
                ];
            }
            case "group": return this.groupChildren(node.project, node.group);
            case "plugin": {
                const { plugin, project } = node;
                if (!plugin.goals.length) {
                    return [{ kind: "info", label: "Goals unknown", description: "the plugin is not in the local repository yet", icon: "info" }];
                }
                return plugin.goals.map((goal): Node => ({ kind: "goal", project, goals: [`${plugin.prefix}:${goal}`], label: `${plugin.prefix}:${goal}` }));
            }
            default: return [];
        }
    }

    private groupChildren(project: PomProject, group: Group): Node[] {
        switch (group) {
            case "lifecycle": return LIFECYCLE_PHASES.map((phase): Node => ({ kind: "goal", project, goals: [phase], label: phase }));
            case "plugins": {
                const plugins = projectPlugins(project);
                return plugins.length ? plugins.map((plugin): Node => ({ kind: "plugin", project, plugin }))
                    : [{ kind: "info", label: "No plugins declared", description: "use Execute Maven Goal… for any other goal", icon: "info" }];
            }
            case "dependencies": {
                let classpath: ReturnType<typeof resolveClasspath>;
                try { classpath = resolveClasspath(project.dir); } catch { return [{ kind: "info", label: "Could not read the dependencies", icon: "warning" }]; }
                const jars = classpath.entries.map(coordinates).filter((c): c is NonNullable<typeof c> => !!c)
                    .sort((a, b) => `${a.groupId}:${a.artifactId}`.localeCompare(`${b.groupId}:${b.artifactId}`));
                return [
                    ...jars.map((c): Node => ({ kind: "info", label: c.artifactId, description: c.version, tooltip: `${c.groupId}:${c.artifactId}:${c.version}`, icon: "library" })),
                    ...classpath.missing.map((m): Node => ({ kind: "info", label: m, description: "not downloaded yet", icon: "warning" })),
                ];
            }
            case "profiles": {
                const ids = [...new Set([...project.profiles, ...settingsProfiles()])];
                return ids.length ? ids.map((id): Node => ({ kind: "profile", project, id })) : [{ kind: "info", label: "No profiles", icon: "info" }];
            }
            case "runs": {
                const lines = this.perProject("maven.runs", project);
                return lines.length ? lines.map((line): Node => ({ kind: "run", project, line }))
                    : [{ kind: "info", label: "None yet", description: "use + to save goals you run often", icon: "info" }];
            }
        }
    }

    getTreeItem(node: Node): vscode.TreeItem {
        const activate = (title: string): vscode.Command => ({ command: "kotlinDebugger.maven.activate", title, arguments: [node] });
        switch (node.kind) {
            case "jdk": {
                const resource = node.folder?.uri;
                const jdk = this.jdks.current(resource);
                const item = new vscode.TreeItem(node.single || !node.folder ? "Project JDK" : `Project JDK (${node.folder.name})`);
                item.description = jdk ? `${jdk.version || "unknown version"}${jdk.vendor ? ` · ${jdk.vendor}` : ""}` : "not selected: click to choose";
                item.tooltip = jdk ? `${jdkLabel(jdk)}\n${jdk.home}\nEvery Maven run from this view uses this JDK. Click to change.` : "Choose the JDK that runs Maven for this workspace.";
                item.iconPath = new vscode.ThemeIcon(jdk ? "coffee" : "warning");
                item.command = { command: "kotlinDebugger.selectProjectJdk", title: "Select Project JDK", arguments: [node] };
                item.contextValue = "mavenJdk";
                return item;
            }
            case "options": {
                const item = new vscode.TreeItem("Options");
                item.description = SWITCHES.filter(s => this.switches()[s.key]).map(s => s.label.toLowerCase()).join(", ");
                item.iconPath = new vscode.ThemeIcon("settings-gear");
                item.command = { command: "kotlinDebugger.maven.options", title: "Maven Options" };
                return item;
            }
            case "project": {
                const { project } = node;
                const item = new vscode.TreeItem(project.name, node.root && this.roots.length <= 3
                    ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
                item.description = [project.version, project.packaging === "jar" ? "" : project.packaging].filter(Boolean).join(" · ");
                item.tooltip = `${project.groupId}:${project.artifactId}:${project.version}\n${project.file}`;
                item.iconPath = new vscode.ThemeIcon("package");
                item.contextValue = "mavenProject";
                return item;
            }
            case "group": {
                const item = new vscode.TreeItem(GROUPS[node.group], node.group === "lifecycle"
                    ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon({ lifecycle: "sync", plugins: "plug", dependencies: "library", profiles: "checklist", runs: "run-all" }[node.group]);
                item.contextValue = node.group === "runs" ? "mavenRuns" : "mavenGroup";
                return item;
            }
            case "plugin": {
                const item = new vscode.TreeItem(node.plugin.prefix, vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `${node.plugin.artifactId}${node.plugin.version ? `:${node.plugin.version}` : ""}`;
                item.tooltip = `${node.plugin.groupId}:${item.description}`;
                item.iconPath = new vscode.ThemeIcon("plug");
                return item;
            }
            case "goal": {
                const item = new vscode.TreeItem(node.label);
                item.tooltip = `mvn ${node.goals.join(" ")}  (double-click or the run button)`;
                item.iconPath = new vscode.ThemeIcon("gear");
                item.command = activate("Run");
                item.contextValue = "mavenGoal";
                return item;
            }
            case "run": {
                const item = new vscode.TreeItem(node.line);
                item.tooltip = `mvn ${node.line}  (double-click or the run button)`;
                item.iconPath = new vscode.ThemeIcon("play-circle");
                item.command = activate("Run");
                item.contextValue = "mavenRun";
                return item;
            }
            case "profile": {
                const item = new vscode.TreeItem(node.id);
                item.checkboxState = this.perProject("maven.profiles", node.project).includes(node.id)
                    ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
                item.tooltip = `-P ${node.id}`;
                return item;
            }
            case "info": {
                const item = new vscode.TreeItem(node.label);
                item.description = node.description;
                item.tooltip = node.tooltip;
                if (node.icon) { item.iconPath = new vscode.ThemeIcon(node.icon); }
                return item;
            }
        }
    }

    async profilesChecked(items: ReadonlyArray<[Node, vscode.TreeItemCheckboxState]>): Promise<void> {
        for (const [node, state] of items) {
            if (node.kind !== "profile") { continue; }
            const active = new Set(this.perProject("maven.profiles", node.project));
            if (state === vscode.TreeItemCheckboxState.Checked) { active.add(node.id); } else { active.delete(node.id); }
            await this.setPerProject("maven.profiles", node.project, [...active]);
        }
    }

    // ---- commands

    /** A second click on the same row within a moment runs it, like a double-click in IntelliJ's Maven window. */
    activate(node: Node): void {
        const now = Date.now();
        const again = this.lastClick && this.lastClick.node === node && now - this.lastClick.time < 600;
        this.lastClick = again ? undefined : { node, time: now };
        if (again) { this.runNode(node, false); }
    }

    runNode(node: Node | undefined, debug: boolean): void {
        const goals = node?.kind === "goal" ? node.goals : node?.kind === "run" ? splitGoals(node.line) : undefined;
        if (!node || !goals || !("project" in node)) { return; }
        this.start(node.project, goals, debug).catch(e => vscode.window.showErrorMessage(`Maven: ${(e as Error).message}`));
    }

    async selectJdk(arg?: Node | string): Promise<void> {
        const node = typeof arg === "object" && arg.kind === "jdk" ? arg : undefined;
        const editor = vscode.window.activeTextEditor?.document.uri;
        const resource = node?.folder?.uri
            ?? (editor && vscode.workspace.getWorkspaceFolder(editor) ? editor : undefined)
            ?? (this.roots[0] ? vscode.Uri.file(this.roots[0].file) : vscode.workspace.workspaceFolders?.[0]?.uri);
        const project = this.roots.find(p => !resource || vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p.file)) === vscode.workspace.getWorkspaceFolder(resource));
        await this.jdks.select(resource, project && requiredJavaVersion(project.properties, project.dir), typeof arg === "string" ? arg : undefined);
        this.changed();
    }

    private async pickProject(node?: Node): Promise<PomProject | undefined> {
        if (node && "project" in node) { return node.project; }
        if (this.roots.length <= 1) { return this.roots[0]; }
        const pick = await vscode.window.showQuickPick(
            this.roots.map(project => ({ label: project.name, description: vscode.workspace.asRelativePath(project.dir), project })),
            { placeHolder: "Maven project" });
        return pick?.project;
    }

    /** Goals typed by the user; earlier command lines are offered. */
    private askGoals(title: string): Promise<string | undefined> {
        const history = this.state<string[]>("maven.history", []);
        const picker = vscode.window.createQuickPick();
        picker.title = title;
        picker.placeholder = "Goals and options, for example: clean package -DskipTests";
        const show = () => {
            const typed = picker.value.trim();
            picker.items = [...(typed ? [{ label: typed, description: "run this" }] : []), ...history.filter(h => h !== typed).map(label => ({ label }))];
        };
        show();
        return new Promise(resolve => {
            picker.onDidChangeValue(show);
            picker.onDidAccept(() => {
                const line = (picker.selectedItems[0]?.label ?? picker.value).trim();
                picker.hide();
                resolve(line || undefined);
            });
            picker.onDidHide(() => { picker.dispose(); resolve(undefined); });
            picker.show();
        });
    }

    async execute(node?: Node): Promise<void> {
        const project = await this.pickProject(node);
        if (!project) { return; }
        const line = await this.askGoals(`Execute Maven Goal (${project.name})`);
        if (!line) { return; }
        const history = this.state<string[]>("maven.history", []);
        await this.context.workspaceState.update("maven.history", [line, ...history.filter(h => h !== line)].slice(0, 20));
        await this.start(project, splitGoals(line), false);
    }

    async chooseOptions(): Promise<void> {
        const current = this.switches();
        const picks = await vscode.window.showQuickPick(
            SWITCHES.map(s => ({ label: s.label, detail: s.detail, picked: current[s.key], key: s.key })),
            { canPickMany: true, title: "Maven options for every run from the Maven view" });
        if (!picks) { return; }
        const chosen = new Set(picks.map(p => p.key));
        await this.context.workspaceState.update("maven.options", Object.fromEntries(SWITCHES.map(s => [s.key, chosen.has(s.key)])));
        this.changed();
    }

    async addRun(node?: Node): Promise<void> {
        const project = await this.pickProject(node);
        if (!project) { return; }
        const line = await this.askGoals(`Save a run configuration (${project.name})`);
        if (!line) { return; }
        await this.setPerProject("maven.runs", project, [...this.perProject("maven.runs", project).filter(l => l !== line), line]);
    }

    async removeRun(node: Node): Promise<void> {
        if (node?.kind !== "run") { return; }
        await this.setPerProject("maven.runs", node.project, this.perProject("maven.runs", node.project).filter(l => l !== node.line));
    }

    async openPom(node: Node): Promise<void> {
        if (node?.kind === "project") { await vscode.window.showTextDocument(vscode.Uri.file(node.project.file)); }
    }

    // ---- running

    /** Starts `mvn <goals>` for a project as a task that uses the Project JDK; with `debug`, attaches the Kotlin debugger. */
    async start(project: PomProject, goals: string[], debug: boolean): Promise<vscode.TaskExecution | undefined> {
        if (!goals.length) { return undefined; }
        const pom = vscode.Uri.file(project.file);
        const folder = vscode.workspace.getWorkspaceFolder(pom);
        const wanted = requiredJavaVersion(project.properties, project.dir);
        const jdk = await this.jdks.ensure(pom, wanted);
        if (!jdk) { return undefined; }
        this.changed();
        const settings = vscode.workspace.getConfiguration("kotlinDebugger", pom);
        const maven = findMaven(project.dir, folder?.uri.fsPath, settings.get<string>("maven.executable") || undefined, this.context.asAbsolutePath("maven"));
        if (!maven) {
            const open = "Open Settings";
            const configured = settings.get<string>("maven.executable");
            vscode.window.showErrorMessage(
                configured ? `Maven not found at ${configured} (kotlinDebugger.maven.executable).`
                    : "Maven not found: the project has no mvnw, and there is no mvn on PATH. Set kotlinDebugger.maven.executable.", open,
            ).then(choice => { if (choice === open) { vscode.commands.executeCommand("workbench.action.openSettings", "kotlinDebugger.maven.executable"); } });
            return undefined;
        }
        if (wanted && jdk.major && jdk.major < wanted.major && !this.warned.has(`${project.file}|${jdk.home}`)) {
            this.warned.add(`${project.file}|${jdk.home}`);
            const select = "Select Project JDK";
            vscode.window.showWarningMessage(`${project.name} asks for Java ${wanted.major} (${wanted.source}), and the Project JDK is ${jdk.version}.`, select)
                .then(choice => { if (choice === select) { vscode.commands.executeCommand("kotlinDebugger.selectProjectJdk"); } });
        }
        const port = debug ? await freePort() : 0;
        const setup = debug ? debugSetup(goals, port) : { args: [], env: {} };
        const invocation = mavenInvocation(maven, [...goals, ...setup.args], project.dir, jdk.home, this.options(project));
        const name = `${goals.join(" ")} (${project.name})`;
        const task = new vscode.Task(
            { type: "kotlin-maven", goals: goals.join(" "), pom: project.file }, folder ?? vscode.TaskScope.Workspace, name, "Maven",
            new vscode.ProcessExecution(invocation.command, invocation.args, { cwd: invocation.cwd, env: { ...invocation.env, ...setup.env } }), PROBLEM_MATCHERS);
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };
        this.output.appendLine(`[maven] ${maven.script} ${invocation.args.slice(maven.prefixArgs.length).join(" ")}  (${maven.source} Maven, ${jdkLabel(jdk)} at ${jdk.home}, in ${project.dir})`);
        const execution = await vscode.tasks.executeTask(task);
        if (debug) { this.attach(execution, `Debug: mvn ${name}`, port, folder, project); }
        return execution;
    }

    /** Maven's exit code once the task has ended; `undefined` when it was terminated. */
    exitCode(execution: vscode.TaskExecution): Promise<number | undefined> {
        return new Promise(resolve => {
            const subscriptions: vscode.Disposable[] = [];
            const done = (code: number | undefined) => { subscriptions.forEach(s => s.dispose()); resolve(code); };
            subscriptions.push(
                vscode.tasks.onDidEndTaskProcess(e => { if (e.execution === execution) { done(e.exitCode); } }),
                vscode.tasks.onDidEndTask(e => { if (e.execution === execution) { setTimeout(() => done(undefined), 1000); } }),
            );
        });
    }

    /**
     * The forked JVM waits for a debugger on `port` (`suspend=y`), so the adapter keeps trying until the build has
     * reached that point. Stopping the debug session stops Maven; a build that ends first ends the session.
     */
    private attach(execution: vscode.TaskExecution, name: string, port: number, folder: vscode.WorkspaceFolder | undefined, project: PomProject): void {
        let session: vscode.DebugSession | undefined;
        let ended = false;
        const subscriptions = [
            vscode.debug.onDidStartDebugSession(s => {
                if (s.name !== name) { return; }
                session = s;
                if (ended) { vscode.debug.stopDebugging(s); }
            }),
            vscode.debug.onDidTerminateDebugSession(s => {
                if (s !== session) { return; }
                if (!ended) { execution.terminate(); }
                subscriptions.forEach(d => d.dispose());
            }),
            vscode.tasks.onDidEndTask(e => {
                if (e.execution !== execution) { return; }
                ended = true;
                if (session) { vscode.debug.stopDebugging(session); }
            }),
        ];
        vscode.debug.startDebugging(folder, {
            type: this.debugType, request: "attach", name, hostName: "127.0.0.1", port, timeout: 600_000,
            projectRoot: folder?.uri.fsPath ?? project.dir,
        }).then(started => {
            if (!started) {
                if (!ended) { execution.terminate(); }
                subscriptions.forEach(d => d.dispose());
            }
        }, () => undefined);
    }
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}
