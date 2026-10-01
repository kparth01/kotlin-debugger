import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { findJava } from "./java";

export const DEBUG_TYPE = "kotlin-jvm";

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel("Kotlin Debugger");
    context.subscriptions.push(output);

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new AdapterFactory(context)),
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new ConfigurationProvider()),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, new TrackerFactory()),
        vscode.commands.registerCommand("kotlinDebugger.attach", attachCommand),
        vscode.commands.registerCommand("kotlinDebugger.showLog", () => openAdapterLog()),
    );
}

export function deactivate(): void { /* adapter processes are owned by VS Code */ }

function settings() {
    return vscode.workspace.getConfiguration("kotlinDebugger");
}

function adapterLogFile(): string {
    return path.join(os.tmpdir(), "kotlin-debug-adapter", "adapter.log");
}

async function openAdapterLog() {
    const file = adapterLogFile();
    if (!fs.existsSync(file)) {
        vscode.window.showInformationMessage(`No adapter log yet (${file}). Start a Kotlin debug session first.`);
        return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
}

/** Starts the bundled adapter jar (`server/kotlin-debug-adapter.jar`) with a suitable JDK. */
class AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor> {
        const jar = this.context.asAbsolutePath(path.join("server", "kotlin-debug-adapter.jar"));
        if (!fs.existsSync(jar)) {
            throw new Error(`Kotlin debug adapter not found at ${jar}. Rebuild the extension (scripts/build.sh).`);
        }
        const runtime = await findJava(settings().get<string>("javaHome") || undefined);
        const level = (session.configuration.logLevel as string | undefined) ?? settings().get<string>("logLevel", "INFO");
        const logFile = adapterLogFile();
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const args = [
            ...settings().get<string[]>("adapterJvmArgs", ["-Xmx512m"]),
            "-jar", jar, "--log-level", level, "--log-file", logFile,
        ];
        output.appendLine(`[${new Date().toISOString()}] Starting adapter: ${runtime.java} ${args.join(" ")} (Java ${runtime.version} from ${runtime.source})`);
        return new vscode.DebugAdapterExecutable(runtime.java, args);
    }
}

/** Fills defaults and validates `launch.json` entries before the session starts. */
class ConfigurationProvider implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[] {
        return [{
            type: DEBUG_TYPE,
            request: "attach",
            name: "Attach to JVM (Kotlin)",
            hostName: "localhost",
            port: 5005,
            projectRoot: folder ? "${workspaceFolder}" : undefined,
        }];
    }

    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): vscode.DebugConfiguration | undefined {
        // F5 without a launch.json: default to attaching on 5005.
        if (!config.type && !config.request && !config.name) {
            config.type = DEBUG_TYPE;
            config.request = "attach";
            config.name = "Attach to JVM (Kotlin)";
            config.port = 5005;
        }
        config.request = config.request ?? "attach";
        const root = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!config.projectRoot && root) { config.projectRoot = root; }
        if (Array.isArray(config.sourcePaths) && root) {
            config.sourcePaths = config.sourcePaths.map((p: string) => path.isAbsolute(p) ? p : path.join(root, p));
        }
        if (config.request === "attach") {
            config.hostName = config.hostName ?? config.host ?? "localhost";
            if (config.port === undefined || config.port === null || isNaN(Number(config.port))) {
                vscode.window.showErrorMessage("Kotlin attach: 'port' is required (the JDWP port of the JVM, e.g. 5005).");
                return undefined;
            }
            config.port = Number(config.port);
        } else if (config.request === "launch") {
            if (!config.mainClass) {
                vscode.window.showErrorMessage("Kotlin launch: 'mainClass' is required (e.g. com.example.MainKt).");
                return undefined;
            }
            config.cwd = config.cwd ?? config.projectRoot;
        }
        if (!config.projectRoot) {
            vscode.window.showWarningMessage("Kotlin debugger: no 'projectRoot' and no workspace folder; breakpoints cannot be mapped to sources.");
        }
        return config;
    }
}

/** Optional protocol tracing to the output channel, plus surfacing adapter crashes. */
class TrackerFactory implements vscode.DebugAdapterTrackerFactory {
    createDebugAdapterTracker(): vscode.DebugAdapterTracker {
        const trace = settings().get<boolean>("traceProtocol", false);
        return {
            onWillReceiveMessage: m => { if (trace) { output.appendLine(`--> ${JSON.stringify(m)}`); } },
            onDidSendMessage: m => { if (trace) { output.appendLine(`<-- ${JSON.stringify(m)}`); } },
            onError: e => output.appendLine(`Adapter error: ${e.message}`),
            onExit: (code, signal) => {
                if (code) {
                    output.appendLine(`Adapter exited with code ${code}${signal ? ` (${signal})` : ""}. Log: ${adapterLogFile()}`);
                    output.show(true);
                }
            },
        };
    }
}

async function attachCommand() {
    const value = await vscode.window.showInputBox({
        prompt: "JDWP address of the JVM (host:port)",
        value: "localhost:5005",
        validateInput: v => /^[^:\s]+:\d+$/.test(v.trim()) || /^\d+$/.test(v.trim()) ? undefined : "Use host:port, e.g. localhost:5005",
    });
    if (!value) { return; }
    const [host, port] = value.includes(":") ? value.trim().split(":") : ["localhost", value.trim()];
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.debug.startDebugging(folder, {
        type: DEBUG_TYPE,
        request: "attach",
        name: `Attach to ${host}:${port} (Kotlin)`,
        hostName: host,
        port: Number(port),
    });
}
