import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";

/**
 * The manual workflow of springboot-debug-playground, automated: pick the launch configuration
 * "Start app + attach (Kotlin)" -> its preLaunchTask starts the app with JDWP and waits for
 * Spring Boot -> the debugger attaches -> a request stops on a Kotlin breakpoint.
 */
function markerLine(file: string, marker: string): number {
    const idx = fs.readFileSync(file, "utf8").split("\n").findIndex(l => l.includes(marker));
    assert.ok(idx >= 0, marker);
    return idx;
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 120_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const v = probe();
        if (v) { return v; }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function get(urlPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: 8080, path: urlPath }, res => {
            let data = "";
            res.on("data", c => (data += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        }).on("error", reject);
    });
}

suite("Playground: F5 starts the app (preLaunchTask) and attaches", function () {
    const workspace = process.env.KDA_E2E_WORKSPACE!;
    const stopped: any[] = [];

    suiteSetup(() => {
        vscode.debug.registerDebugAdapterTrackerFactory("kotlin-jvm", {
            createDebugAdapterTracker: () => ({
                onDidSendMessage: (m: any) => { if (m.type === "event" && m.event === "stopped") { stopped.push(m.body); } },
            }),
        });
    });

    suiteTeardown(async () => {
        // stop the background task (the app)
        for (const e of vscode.tasks.taskExecutions) { e.terminate(); }
    });

    test("Start app + attach (Kotlin)", async function () {
        const file = path.join(workspace, "src/main/kotlin/com/example/playground/GreetingController.kt");
        const line = markerLine(file, "BREAKPOINT 1");
        vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(line, 0)))]);

        const folder = vscode.workspace.workspaceFolders![0];
        const started = await vscode.debug.startDebugging(folder, "Start app + attach (Kotlin)");
        assert.ok(started, "launch configuration started (preLaunchTask finished, adapter attached)");
        const session = await waitFor("debug session", () => vscode.debug.activeDebugSession);

        const response = get("/hello?name=Ada");
        const stop = await waitFor("breakpoint hit", () => stopped[0]);
        const st = await session.customRequest("stackTrace", { threadId: stop.threadId, levels: 5 });
        assert.strictEqual(st.stackFrames[0].name, "GreetingController.hello");
        assert.strictEqual(st.stackFrames[0].line, line + 1);
        const ev = await session.customRequest("evaluate", { expression: "name.length", frameId: st.stackFrames[0].id, context: "repl" });
        assert.strictEqual(ev.result, "3");

        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await vscode.commands.executeCommand("workbench.action.debug.continue");
        assert.strictEqual((await response).status, 200);
        await vscode.debug.stopDebugging(session);
    });
});
