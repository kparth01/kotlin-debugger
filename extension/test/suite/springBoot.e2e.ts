import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";

const TYPE = "kotlin-jvm";

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
        s.on("error", reject);
    });
}

function markerLine(file: string, marker: string): number {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const idx = lines.findIndex(l => l.includes(`// @bp:${marker}`));
    assert.ok(idx >= 0, `marker ${marker} in ${file}`);
    return idx; // 0-based for vscode.Position
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const v = probe();
        if (v) { return v; }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function request(port: number, method: string, urlPath: string, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: body ? { "Content-Type": "application/json" } : {} }, res => {
            let data = "";
            res.on("data", c => (data += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        req.on("error", reject);
        if (body) { req.write(body); }
        req.end();
    });
}

suite("VS Code -> Kotlin debugger -> JDWP -> Spring Boot (JDK 21)", function () {
    const workspace = process.env.KDA_E2E_WORKSPACE!;
    const jar = path.join(workspace, "target", "spring-boot-kotlin-demo.jar");
    const src = path.join(workspace, "src/main/kotlin/com/example/demo");
    let app: cp.ChildProcess | undefined;
    let appOut = "";
    let httpPort = 0;
    let jdwpPort = 0;
    const stopped: any[] = [];
    const outputs: string[] = [];

    suiteSetup(async function () {
        assert.ok(fs.existsSync(jar), `build the sample first: ${jar}`);
        httpPort = await freePort();
        const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : "java";
        // The JVM runs independently of VS Code, exactly like a remote/dev server.
        app = cp.spawn(java, [
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0",
            "-jar", jar, `--server.port=${httpPort}`,
        ]);
        app.stdout!.on("data", d => (appOut += d.toString()));
        app.stderr!.on("data", d => (appOut += d.toString()));
        await waitFor("JDWP port", () => {
            const m = /Listening for transport dt_socket at address: (\d+)/.exec(appOut);
            if (m) { jdwpPort = parseInt(m[1], 10); }
            return m !== null;
        });
        await waitFor("Spring Boot startup", () => appOut.includes("Started DemoApplicationKt"), 120_000);

        vscode.debug.registerDebugAdapterTrackerFactory(TYPE, {
            createDebugAdapterTracker: () => ({
                onDidSendMessage: (m: any) => {
                    if (m.type === "event" && m.event === "stopped") { stopped.push(m.body); }
                    if (m.type === "event" && m.event === "output") { outputs.push(m.body.output); }
                },
            }),
        });
    });

    suiteTeardown(() => {
        app?.kill();
    });

    test("attach, hit Kotlin breakpoints, inspect, step and evaluate", async function () {
        const pricing = path.join(src, "service/PricingService.kt");
        const controller = path.join(src, "web/OrderController.kt");
        const pricingUri = vscode.Uri.file(pricing);
        const bpPrice = new vscode.SourceBreakpoint(new vscode.Location(pricingUri, new vscode.Position(markerLine(pricing, "price-subtotal"), 0)));
        const bpController = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(controller), new vscode.Position(markerLine(controller, "controller-create"), 0)));
        vscode.debug.addBreakpoints([bpController, bpPrice]);

        const folder = vscode.workspace.workspaceFolders![0];
        const started = await vscode.debug.startDebugging(folder, {
            type: TYPE, request: "attach", name: "E2E attach", hostName: "127.0.0.1", port: jdwpPort,
        });
        assert.ok(started, "debug session started");
        const session = await waitFor("active session", () => vscode.debug.activeDebugSession);
        assert.strictEqual(session.type, TYPE);
        await waitFor("attach banner", () => outputs.some(o => o.includes("attached to")));

        const response = request(httpPort, "POST", "/orders",
            JSON.stringify({ customerId: "acme", lines: [{ productId: "apple", quantity: 12, unitPrice: 0.5 }] }));

        // --- stop 1: controller
        const s1 = await waitFor("stop in controller", () => stopped[0]);
        assert.strictEqual(s1.reason, "breakpoint");
        const st1 = await session.customRequest("stackTrace", { threadId: s1.threadId, startFrame: 0, levels: 30 });
        assert.strictEqual(st1.stackFrames[0].name, "OrderController.create");
        assert.ok(st1.stackFrames[0].source.path.endsWith("OrderController.kt"));
        assert.strictEqual(st1.stackFrames[0].line, markerLine(controller, "controller-create") + 1);
        // VS Code itself navigates to the .kt file at the stop location
        await waitFor("editor shows OrderController.kt", () =>
            vscode.window.activeTextEditor?.document.uri.fsPath.endsWith("OrderController.kt"), 20_000);

        const scopes = await session.customRequest("scopes", { frameId: st1.stackFrames[0].id });
        const vars = await session.customRequest("variables", { variablesReference: scopes.scopes[0].variablesReference });
        const req = vars.variables.find((v: any) => v.name === "request");
        assert.ok(req && req.value.startsWith("OrderRequest(customerId=acme"), JSON.stringify(vars.variables));
        const ev = await session.customRequest("evaluate", { expression: "request.lines[0].quantity * 2", frameId: st1.stackFrames[0].id, context: "watch" });
        assert.strictEqual(ev.result, "24");

        // --- continue to stop 2: inside the inline `timed {}` lambda in PricingService
        await vscode.commands.executeCommand("workbench.action.debug.continue");
        const s2 = await waitFor("stop in PricingService", () => stopped[1]);
        const st2 = await session.customRequest("stackTrace", { threadId: s2.threadId, startFrame: 0, levels: 60 });
        assert.strictEqual(st2.stackFrames[0].name, "PricingService.price");
        assert.strictEqual(st2.stackFrames[0].line, markerLine(pricing, "price-subtotal") + 1);
        const names: string[] = st2.stackFrames.map((f: any) => f.name);
        assert.ok(names.includes("OrderService.placeOrder (Spring proxy)"), names.join(", "));
        assert.ok(names.includes("OrderController.create"), names.join(", "));
        const bulk = await session.customRequest("evaluate", { expression: "order.itemCount >= BULK_THRESHOLD", frameId: st2.stackFrames[0].id, context: "repl" });
        assert.strictEqual(bulk.result, "true");

        // --- step over through the VS Code command
        await vscode.commands.executeCommand("workbench.action.debug.stepOver");
        const s3 = await waitFor("step", () => stopped[2]);
        assert.strictEqual(s3.reason, "step");
        const st3 = await session.customRequest("stackTrace", { threadId: s3.threadId, startFrame: 0, levels: 1 });
        assert.strictEqual(st3.stackFrames[0].line, markerLine(pricing, "price-subtotal") + 2);
        const sc3 = await session.customRequest("scopes", { frameId: st3.stackFrames[0].id });
        const v3 = await session.customRequest("variables", { variablesReference: sc3.scopes[0].variablesReference });
        assert.strictEqual(v3.variables.find((v: any) => v.name === "subtotal")?.value, "6.0");

        // --- Run to Cursor (VS Code core: temporary breakpoint + continue)
        const editor = await vscode.window.showTextDocument(pricingUri);
        const target = markerLine(pricing, "price-total");
        editor.selection = new vscode.Selection(target, 0, target, 0);
        await vscode.commands.executeCommand("editor.debug.action.runToCursor");
        const s4 = await waitFor("run to cursor", () => stopped[3]);
        const st4 = await session.customRequest("stackTrace", { threadId: s4.threadId, startFrame: 0, levels: 1 });
        assert.strictEqual(st4.stackFrames[0].line, target + 1);

        // --- finish: remove breakpoints, continue, request completes
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await vscode.commands.executeCommand("workbench.action.debug.continue");
        const res = await response;
        assert.strictEqual(res.status, 201, res.body);
        assert.ok(res.body.includes("\"total\":5.40"), res.body); // 10% bulk discount on 6.00

        // --- detach; the server keeps running
        await vscode.debug.stopDebugging(session);
        await waitFor("session ended", () => !vscode.debug.activeDebugSession, 20_000);
        const after = await request(httpPort, "GET", "/orders/revenue");
        assert.strictEqual(after.status, 200);
        assert.ok(app && app.exitCode === null, "app still running after detach");
    });
});
