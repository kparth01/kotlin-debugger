import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findBuildRoot, resolveClasspath } from "../completion/classpath";
import { MavenApi } from "../maven/mavenView";
import { findMains } from "./kotlinMain";

/** "Run | Debug" above every top-level `fun main` of a Kotlin file. */
export function registerMainLens(context: vscode.ExtensionContext, selector: vscode.DocumentSelector, maven: MavenApi, debugType: string): void {
    const changed = new vscode.EventEmitter<void>();
    const enabled = () => vscode.workspace.getConfiguration("kotlinDebugger").get<boolean>("run.codeLens", true);
    const provider: vscode.CodeLensProvider = {
        onDidChangeCodeLenses: changed.event,
        provideCodeLenses(doc) {
            if (!enabled() || doc.uri.scheme !== "file") { return []; }
            return findMains(doc.getText(), doc.fileName).flatMap(main => {
                const range = new vscode.Range(main.line, 0, main.line, 0);
                return [
                    new vscode.CodeLens(range, { title: "$(play) Run", command: "kotlinDebugger.runMain", arguments: [doc.uri, main.mainClass], tooltip: `Build and run ${main.mainClass}` }),
                    new vscode.CodeLens(range, { title: "$(debug-alt) Debug", command: "kotlinDebugger.debugMain", arguments: [doc.uri, main.mainClass], tooltip: `Build and debug ${main.mainClass}` }),
                ];
            });
        },
    };
    const launch = (debug: boolean) => (uri: vscode.Uri, mainClass: string, overrides?: Record<string, unknown>) =>
        launchMain(uri, mainClass, debug, maven, debugType, overrides);
    context.subscriptions.push(
        changed,
        vscode.languages.registerCodeLensProvider(selector, provider),
        vscode.commands.registerCommand("kotlinDebugger.runMain", launch(false)),
        vscode.commands.registerCommand("kotlinDebugger.debugMain", launch(true)),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration("kotlinDebugger.run")) { changed.fire(); } }),
    );
}

/**
 * Compiles the project (`mvn compile` with the Project JDK, for a Maven project) and starts `mainClass` through the
 * `kotlin-jvm` launch configuration, with the classpath read from the build files. True when the session started.
 */
async function launchMain(
    uri: vscode.Uri, mainClass: string, debug: boolean, maven: MavenApi, debugType: string, overrides: Record<string, unknown> = {},
): Promise<boolean> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const root = findBuildRoot(path.dirname(uri.fsPath), folder?.uri.fsPath ?? path.parse(uri.fsPath).root) ?? folder?.uri.fsPath ?? path.dirname(uri.fsPath);
    const pom = path.join(root, "pom.xml");
    if (fs.existsSync(pom) && vscode.workspace.getConfiguration("kotlinDebugger", uri).get<boolean>("run.buildBeforeLaunch", true)) {
        await vscode.workspace.saveAll(false);
        const exitCode = await maven.run(pom, ["compile"]);
        if (exitCode === undefined) { return false; }
        if (exitCode !== 0) {
            vscode.window.showErrorMessage(`Build failed (mvn compile, exit code ${exitCode}). The errors are in the terminal and the Problems panel.`);
            return false;
        }
    }
    const classPaths = resolveClasspath(root).entries;
    if (!classPaths.length) {
        vscode.window.showErrorMessage(`No classes or dependencies found for ${root}. Build the project first.`);
        return false;
    }
    return vscode.debug.startDebugging(folder, {
        type: debugType, request: "launch", name: mainClass.slice(mainClass.lastIndexOf(".") + 1).replace(/Kt$/, ""),
        mainClass, projectRoot: root, cwd: root, classPaths, ...overrides,
    }, { noDebug: !debug });
}
