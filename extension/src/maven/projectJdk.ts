import * as path from "path";
import * as vscode from "vscode";
import { discoverJdks, Jdk, jdkLabel, readJdk } from "./jdks";

const SETTING = "projectJdk";

/**
 * The JDK the user chose for a workspace folder (`kotlinDebugger.projectJdk` in the folder's settings). Maven runs
 * started from the Maven view use it; once chosen, completion and Kotlin launches use it too.
 */
export class ProjectJdk implements vscode.Disposable {
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly subscription: vscode.Disposable;
    private statusFolder: vscode.Uri | undefined;
    readonly onDidChange = this.changed.event;

    constructor() {
        this.status.command = "kotlinDebugger.selectProjectJdk";
        this.subscription = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(`kotlinDebugger.${SETTING}`) || e.affectsConfiguration("kotlinDebugger.jdks")) {
                this.updateStatus();
                this.changed.fire();
            }
        });
    }

    dispose(): void {
        this.status.dispose();
        this.changed.dispose();
        this.subscription.dispose();
    }

    /** The chosen JDK for the folder of `resource`; `undefined` when none is chosen or the path is no longer a JDK. */
    current(resource?: vscode.Uri): Jdk | undefined {
        const home = vscode.workspace.getConfiguration("kotlinDebugger", resource).get<string>(SETTING, "");
        return home ? readJdk(home, "kotlinDebugger.projectJdk") : undefined;
    }

    available(resource?: vscode.Uri): Jdk[] {
        return discoverJdks(vscode.workspace.getConfiguration("kotlinDebugger", resource).get<string[]>("jdks", []));
    }

    /** The chosen JDK, or the picker when there is none yet. */
    async ensure(resource: vscode.Uri | undefined, wanted?: { major: number; source: string }): Promise<Jdk | undefined> {
        return this.current(resource) ?? this.select(resource, wanted);
    }

    /** Shows the picker (or takes `home` as the choice) and saves the result for the folder of `resource`. */
    async select(resource?: vscode.Uri, wanted?: { major: number; source: string }, home?: string): Promise<Jdk | undefined> {
        let jdk = home ? readJdk(home, "kotlinDebugger.projectJdk") : undefined;
        if (home && !jdk) {
            vscode.window.showErrorMessage(`${home} is not a JDK (no bin/javac).`);
            return undefined;
        }
        if (!jdk) {
            const current = this.current(resource);
            type Item = vscode.QuickPickItem & { jdk?: Jdk; browse?: boolean };
            const items: Item[] = this.available(resource).map(found => ({
                label: `$(coffee) ${jdkLabel(found)}`,
                description: [
                    wanted && found.major === wanted.major ? `matches ${wanted.source}` : "",
                    current && current.home === found.home ? "current" : "",
                ].filter(Boolean).join(" · "),
                detail: `${found.home}  (${found.source})`,
                jdk: found,
            }));
            items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(folder-opened) Browse…", detail: "Choose a JDK folder that is not listed", browse: true });
            const folder = resource && vscode.workspace.getWorkspaceFolder(resource);
            const pick = await vscode.window.showQuickPick(items, {
                title: `Project JDK${folder ? ` for ${folder.name}` : ""}`,
                placeHolder: wanted ? `The project asks for Java ${wanted.major} (${wanted.source})` : "JDK used for Maven, completion and launching",
                matchOnDetail: true,
            });
            if (!pick) { return undefined; }
            jdk = pick.jdk;
            if (pick.browse) {
                const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: "Use this JDK", title: "Select a JDK home" });
                if (!chosen?.length) { return undefined; }
                jdk = readJdk(chosen[0].fsPath, "kotlinDebugger.projectJdk");
                if (!jdk) {
                    vscode.window.showErrorMessage(`${chosen[0].fsPath} is not a JDK (no bin/javac).`);
                    return undefined;
                }
            }
        }
        if (!jdk) { return undefined; }
        const inFolder = !!resource && !!vscode.workspace.getWorkspaceFolder(resource);
        await vscode.workspace.getConfiguration("kotlinDebugger", resource)
            .update(SETTING, jdk.home, inFolder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global);
        this.updateStatus();
        return jdk;
    }

    /** Shows the status-bar item for the given folder; `undefined` hides it. */
    showStatus(resource: vscode.Uri | undefined, visible: boolean): void {
        this.statusFolder = resource;
        if (visible) { this.updateStatus(); this.status.show(); } else { this.status.hide(); }
    }

    private updateStatus(): void {
        const jdk = this.current(this.statusFolder);
        this.status.text = jdk ? `$(coffee) JDK ${jdk.major || jdk.version}` : "$(coffee) Select JDK";
        this.status.tooltip = jdk
            ? `Project JDK: ${jdkLabel(jdk)}\n${jdk.home}\nUsed for Maven, completion and launching. Click to change.`
            : "No Project JDK selected. Click to choose the JDK for Maven, completion and launching.";
    }
}

/** `<home>/bin/java` of the Project JDK for `resource`, if one is chosen. */
export function projectJavaExecutable(resource?: vscode.Uri): string | undefined {
    const home = vscode.workspace.getConfiguration("kotlinDebugger", resource).get<string>(SETTING, "");
    const jdk = home ? readJdk(home, "kotlinDebugger.projectJdk") : undefined;
    return jdk && path.join(jdk.home, "bin", process.platform === "win32" ? "java.exe" : "java");
}
