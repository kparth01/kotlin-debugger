import * as cp from "child_process";
import * as vscode from "vscode";
import { compilerMessages } from "../maven/invocation";
import { MavenApi } from "../maven/mavenView";

/**
 * `kotlinDebugger.maven.compileOnSave`: after a Kotlin or Java file of a Maven project is saved, `mvn -q compile`
 * runs in the background with the Project JDK and the compiler's messages become problems. One build per project
 * at a time; a save during a build starts another one when it ends.
 */
export function registerCompileOnSave(context: vscode.ExtensionContext, maven: MavenApi, output: vscode.OutputChannel): void {
    const problems = vscode.languages.createDiagnosticCollection("kotlin-build");
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    const timers = new Map<string, NodeJS.Timeout>();
    const running = new Map<string, { again: boolean; process: cp.ChildProcess }>();
    const reported = new Map<string, vscode.Uri[]>();
    let hinted = false;
    const enabled = (uri: vscode.Uri) => vscode.workspace.getConfiguration("kotlinDebugger", uri).get<boolean>("maven.compileOnSave", false);

    const build = (pom: string, name: string) => {
        const current = running.get(pom);
        if (current) { current.again = true; return; }
        const invocation = maven.invocation(pom, ["-q", "compile"]);
        if (!invocation) {
            if (!hinted) {
                hinted = true;
                vscode.window.showInformationMessage("Compile on save needs a Project JDK (and Maven).", "Select Project JDK")
                    .then(choice => { if (choice) { vscode.commands.executeCommand("kotlinDebugger.selectProjectJdk"); } });
            }
            return;
        }
        status.text = `$(sync~spin) Compiling ${name}`;
        status.show();
        const started = Date.now();
        let text = "";
        const child = cp.spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: { ...process.env, ...invocation.env }, windowsHide: true });
        const state = { again: false, process: child };
        running.set(pom, state);
        child.stdout.on("data", chunk => { text += chunk; });
        child.stderr.on("data", chunk => { text += chunk; });
        const finish = (exitCode: number | null, failure?: string) => {
            if (running.get(pom) !== state) { return; }
            running.delete(pom);
            for (const uri of reported.get(pom) ?? []) { problems.delete(uri); }
            const byFile = new Map<string, vscode.Diagnostic[]>();
            for (const m of compilerMessages(text)) {
                const diagnostic = new vscode.Diagnostic(new vscode.Range(m.line, m.column, m.line, m.column + 1), m.message,
                    m.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
                diagnostic.source = m.file.endsWith(".java") ? "javac" : "kotlinc";
                byFile.set(m.file, [...(byFile.get(m.file) ?? []), diagnostic]);
            }
            const uris: vscode.Uri[] = [];
            for (const [file, diagnostics] of byFile) {
                const uri = vscode.Uri.file(file);
                problems.set(uri, diagnostics);
                uris.push(uri);
            }
            reported.set(pom, uris);
            const errors = [...byFile.values()].flat().filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
            output.appendLine(`[build] ${name}: mvn -q compile exited with ${failure ?? exitCode} in ${Date.now() - started} ms, ${errors} error(s)`);
            if (exitCode !== 0 && !errors) { output.appendLine(text.trim().split("\n").slice(-15).join("\n")); }
            status.text = exitCode === 0 ? `$(check) ${name} compiled` : `$(error) ${name}: ${errors || "build"} error${errors === 1 ? "" : "s"}`;
            setTimeout(() => { if (!running.size) { status.hide(); } }, 5000);
            if (state.again) { build(pom, name); }
        };
        child.on("error", e => finish(null, e.message));
        child.on("close", code => finish(code));
    };

    context.subscriptions.push(
        problems, status,
        { dispose: () => { timers.forEach(t => clearTimeout(t)); running.forEach(r => r.process.kill()); } },
        vscode.workspace.onDidSaveTextDocument(doc => {
            if ((doc.languageId !== "kotlin" && doc.languageId !== "java") || doc.uri.scheme !== "file" || !enabled(doc.uri)) { return; }
            const project = maven.projectOf(doc.fileName);
            if (!project) { return; }
            clearTimeout(timers.get(project.file));
            timers.set(project.file, setTimeout(() => { timers.delete(project.file); build(project.file, project.name); }, 800));
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("kotlinDebugger.maven.compileOnSave")) { problems.clear(); reported.clear(); }
        }),
    );
}
