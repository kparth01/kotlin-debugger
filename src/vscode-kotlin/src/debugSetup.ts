import * as vscode from "vscode";
import * as path from "path";
import * as child_process from "child_process";
import { ServerDownloader } from "./serverDownloader";
import { correctScriptName, isOSUnixoid } from "./util/osUtils";
import { ServerSetupParams } from "./setupParams";

export async function registerDebugAdapter({ context, status, config, javaInstallation, javaOpts }: ServerSetupParams): Promise<void> {
    status.update("Registering Kotlin Debug Adapter...");

    // Prepare debug adapter
    // First, try bundled adapter (self-contained VSIX)
    const bundledAdapterPath = path.join(context.extensionPath, "lib", "kotlin-debug-adapter", "bin", correctScriptName("kotlin-debug-adapter"));

    // Fallback to downloaded adapter if bundled not available
    const debugAdapterInstallDir = path.join(context.globalStorageUri.fsPath, "debugAdapterInstall");
    const customPath: string = config.get("debugAdapter.path");

    let startScriptPath = customPath;

    if (!startScriptPath) {
        // Try bundled first
        const fs = await import("fs");
        if (fs.existsSync(bundledAdapterPath)) {
            startScriptPath = bundledAdapterPath;
            status.update("Using bundled Kotlin Debug Adapter");
        } else {
            // Fallback to download
            status.update("Downloading Kotlin Debug Adapter...");
            const debugAdapterDownloader = new ServerDownloader("Kotlin Debug Adapter", "kotlin-debug-adapter", "adapter.zip", "adapter", debugAdapterInstallDir);

            try {
                await debugAdapterDownloader.downloadServerIfNeeded(status);
                startScriptPath = path.join(debugAdapterInstallDir, "adapter", "bin", correctScriptName("kotlin-debug-adapter"));
                status.update("Downloaded Kotlin Debug Adapter");
            } catch (error) {
                console.error(error);
                vscode.window.showErrorMessage(`Could not download Kotlin Debug Adapter: ${error}. Check your internet connection.`);
                return;
            }
        }
    }
    
    // Ensure that start script can be executed
    if (isOSUnixoid()) {
        child_process.exec(`chmod +x ${startScriptPath}`);
    }

    let env: any = { ...process.env };

    if (javaInstallation.javaHome) {
        env['JAVA_HOME'] = javaInstallation.javaHome;
    }

    if (javaOpts) {
        env['JAVA_OPTS'] = javaOpts;
    }
    
    vscode.debug.registerDebugAdapterDescriptorFactory("kotlin", new KotlinDebugAdapterDescriptorFactory(startScriptPath, env));
}

/**
 * A factory that creates descriptors which point
 * to the Kotlin debug adapter start script.
 */
export class KotlinDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    public constructor(
        private startScriptPath: string,
        private env?: any
    ) {}
    
    async createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): Promise<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterExecutable(this.startScriptPath, null, {
            env: this.env
        });
    }
}
