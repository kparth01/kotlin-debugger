import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { MavenApi } from "../maven/mavenView";
import { findTests, readSurefireReport, resultOf, surefireFilter, TestClass, TestOutcome, TestResult } from "./testModel";

export interface TestSelection { fqName: string; methods?: string[] }

export interface TestsApi {
    /** Test classes found in the workspace, by `pom.xml`. */
    discovered(): Promise<Array<{ pom: string; file: string; fqName: string; methods: string[] }>>;
    /** Runs tests through Maven; results by class and method (`errored`: no Surefire report for the class). */
    run(pomFile: string, tests: TestSelection[], debug?: boolean): Promise<{ exitCode: number | undefined; results: Record<string, Record<string, TestOutcome> | "errored"> }>;
}

interface Meta { pom: string; dir: string; file: string; cls: TestClass; method?: string }

/** Runs `mvn test -Dtest=…` with the Project JDK and reads the Surefire reports of the selected classes. */
async function runMavenTests(maven: MavenApi, pom: string, tests: TestSelection[], debug: boolean) {
    const dir = path.dirname(pom);
    for (const t of tests) { fs.rmSync(path.join(dir, "target", "surefire-reports", `TEST-${t.fqName}.xml`), { force: true }); }
    const exitCode = await maven.run(pom, [
        "test", `-Dtest=${surefireFilter(tests)}`, "-Dsurefire.failIfNoSpecifiedTests=false", "-DfailIfNoTests=false", "-DskipTests=false",
    ], debug);
    return { exitCode, reports: new Map(tests.map(t => [t.fqName, readSurefireReport(dir, t.fqName)] as const)) };
}

/**
 * Kotlin tests of Maven projects in VS Code's Testing view and gutter: classes with `@Test` functions below
 * `src/test`, run or debugged through Maven (`-Dtest=Class#method`) with the Project JDK.
 */
export function registerTestExplorer(context: vscode.ExtensionContext, maven: MavenApi, output: vscode.OutputChannel): TestsApi {
    const controller = vscode.tests.createTestController("kotlinDebugger.tests", "Kotlin Tests (Maven)");
    const meta = new Map<string, Meta>();
    const byFile = new Map<string, string[]>();
    const enabled = () => vscode.workspace.getConfiguration("kotlinDebugger").get<boolean>("testing.enabled", true);

    const forget = (file: string) => {
        for (const id of byFile.get(file) ?? []) { controller.items.delete(id); meta.delete(id); }
        byFile.delete(file);
    };

    const load = (file: string, text?: string) => {
        forget(file);
        if (!enabled() || !/[\\/]src[\\/]test[\\/]/.test(file)) { return; }
        const project = maven.projectOf(file);
        if (!project) { return; }
        let source = text;
        if (source === undefined) { try { source = fs.readFileSync(file, "utf8"); } catch { return; } }
        if (!/@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(source)) { return; }
        const uri = vscode.Uri.file(file);
        const ids: string[] = [];
        for (const cls of findTests(source)) {
            const id = `${project.file}|${cls.fqName}`;
            const item = controller.createTestItem(id, cls.name, uri);
            item.description = cls.fqName.slice(0, Math.max(0, cls.fqName.lastIndexOf(".")));
            item.range = new vscode.Range(cls.line, 0, cls.line, 0);
            meta.set(id, { pom: project.file, dir: project.dir, file, cls });
            for (const method of cls.methods) {
                const child = controller.createTestItem(`${id}#${method.name}`, method.name, uri);
                child.range = new vscode.Range(method.line, 0, method.line, 0);
                item.children.add(child);
                meta.set(child.id, { pom: project.file, dir: project.dir, file, cls, method: method.name });
            }
            controller.items.add(item);
            ids.push(id);
        }
        byFile.set(file, ids);
    };

    const discover = async () => {
        [...byFile.keys()].forEach(forget);
        if (!enabled()) { return; }
        const files = await vscode.workspace.findFiles("**/src/test/**/*.kt", "**/{target,build,node_modules,out}/**", 3000);
        for (const file of files) {
            const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.fsPath);
            load(file.fsPath, open?.getText());
        }
    };

    const execute = async (request: vscode.TestRunRequest, debug: boolean) => {
        const run = controller.createTestRun(request);
        const excluded = new Set((request.exclude ?? []).map(i => i.id));
        const roots: vscode.TestItem[] = [];
        if (request.include) { roots.push(...request.include); } else { controller.items.forEach(i => roots.push(i)); }
        // per pom: class → methods (`undefined`: the whole class)
        const plan = new Map<string, Map<string, { cls: vscode.TestItem; methods?: vscode.TestItem[] }>>();
        for (const item of roots) {
            const m = meta.get(item.id);
            if (!m || excluded.has(item.id)) { continue; }
            const classes = plan.get(m.pom) ?? new Map<string, { cls: vscode.TestItem; methods?: vscode.TestItem[] }>();
            plan.set(m.pom, classes);
            const cls = m.method ? item.parent! : item;
            const entry = classes.get(m.cls.fqName) ?? { cls, methods: m.method ? [] : undefined };
            if (m.method) { entry.methods?.push(item); } else { entry.methods = undefined; }
            classes.set(m.cls.fqName, entry);
        }
        try {
            for (const [pom, classes] of plan) {
                const items = (entry: { cls: vscode.TestItem; methods?: vscode.TestItem[] }) => {
                    const all: vscode.TestItem[] = [];
                    if (entry.methods) { all.push(...entry.methods); } else { entry.cls.children.forEach(c => all.push(c)); }
                    return all.filter(i => !excluded.has(i.id));
                };
                for (const entry of classes.values()) { items(entry).forEach(i => run.started(i)); }
                const selection = [...classes].map(([fqName, entry]) => ({ fqName, methods: entry.methods?.map(i => meta.get(i.id)!.method!) }));
                const { exitCode, reports } = await runMavenTests(maven, pom, selection, debug);
                for (const [fqName, entry] of classes) {
                    const report = reports.get(fqName);
                    for (const item of items(entry)) {
                        const result: TestResult | undefined = report && resultOf(report, meta.get(item.id)!.method!);
                        if (!result) {
                            run.errored(item, new vscode.TestMessage(exitCode === undefined ? "Maven was not started (no Project JDK or no Maven)."
                                : report ? "The test did not run." : `No Surefire report: the build failed before the tests ran (mvn exit code ${exitCode}). See the terminal and the Problems panel.`));
                        } else if (result.outcome === "passed") {
                            run.passed(item, result.seconds * 1000);
                        } else if (result.outcome === "skipped") {
                            run.skipped(item);
                        } else {
                            const message = new vscode.TestMessage(result.message ?? "Test failed");
                            if (item.uri) { message.location = new vscode.Location(item.uri, new vscode.Position(result.line ?? item.range?.start.line ?? 0, 0)); }
                            run.failed(item, message, result.seconds * 1000);
                        }
                    }
                }
            }
        } catch (e) {
            output.appendLine(`[tests] ${(e as Error).stack ?? e}`);
        } finally {
            run.end();
        }
    };

    controller.createRunProfile("Run with Maven", vscode.TestRunProfileKind.Run, request => execute(request, false), true);
    controller.createRunProfile("Debug with Maven", vscode.TestRunProfileKind.Debug, request => execute(request, true), true);
    controller.refreshHandler = () => discover();

    const timers = new Map<string, NodeJS.Timeout>();
    const soon = (file: string, text?: () => string) => {
        clearTimeout(timers.get(file));
        timers.set(file, setTimeout(() => { timers.delete(file); load(file, text?.()); }, 500));
    };
    const watcher = vscode.workspace.createFileSystemWatcher("**/src/test/**/*.kt");
    watcher.onDidCreate(uri => soon(uri.fsPath));
    watcher.onDidChange(uri => soon(uri.fsPath));
    watcher.onDidDelete(uri => forget(uri.fsPath));
    context.subscriptions.push(
        controller, watcher,
        { dispose: () => timers.forEach(t => clearTimeout(t)) },
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === "kotlin" && e.document.uri.scheme === "file") { soon(e.document.uri.fsPath, () => e.document.getText()); }
        }),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration("kotlinDebugger.testing")) { discover(); } }),
    );
    const discovering = discover().catch(e => output.appendLine(`[tests] ${(e as Error).stack ?? e}`));

    return {
        discovered: async () => {
            await discovering;
            return [...byFile.values()].flat().map(id => meta.get(id)!).map(m => ({ pom: m.pom, file: m.file, fqName: m.cls.fqName, methods: m.cls.methods.map(x => x.name) }));
        },
        run: async (pomFile, tests, debug) => {
            const { exitCode, reports } = await runMavenTests(maven, pomFile, tests, !!debug);
            const results: Record<string, Record<string, TestOutcome> | "errored"> = {};
            for (const [fqName, report] of reports) {
                results[fqName] = report ? Object.fromEntries([...report].map(([name, r]) => [name, r.outcome])) : "errored";
            }
            return { exitCode, results };
        },
    };
}
