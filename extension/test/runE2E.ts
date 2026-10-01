import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

/**
 * Runs the E2E suite inside a real VS Code instance:
 *   VS Code -> this extension -> adapter jar (DAP/stdio) -> JDWP -> Spring Boot (JDK 21).
 * Uses the locally installed VS Code when available (VSCODE_EXECUTABLE overrides), otherwise
 * downloads a stable build. The sample app must be built first (samples/spring-boot-kotlin-demo).
 */
async function main() {
    const sourceRoot = path.resolve(__dirname, "../..");
    // KDA_E2E_EXTENSION_PATH: run against an unpacked VSIX (…/extension) to test the shipped artifact.
    const extensionDevelopmentPath = process.env.KDA_E2E_EXTENSION_PATH ?? sourceRoot;
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    // KDA_E2E_WORKSPACE + KDA_E2E_SUITE=playground: run the "F5 starts the app and attaches" flow
    // against another project (e.g. springboot-debug-playground).
    const workspace = process.env.KDA_E2E_WORKSPACE ?? path.resolve(sourceRoot, "../samples/spring-boot-kotlin-demo");
    console.log(`Extension under test: ${extensionDevelopmentPath}`);
    const local = process.platform === "darwin"
        ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
        : undefined;
    const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE ?? (local && fs.existsSync(local) ? local : undefined);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kda-e2e-"));
    await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [
            workspace,
            "--disable-extensions",
            "--disable-workspace-trust",
            "--skip-welcome",
            "--skip-release-notes",
            `--user-data-dir=${path.join(tmp, "user")}`,
            `--extensions-dir=${path.join(tmp, "extensions")}`,
        ],
        extensionTestsEnv: { KDA_E2E_WORKSPACE: workspace, KDA_E2E_SUITE: process.env.KDA_E2E_SUITE ?? "springBoot" },
    });
}

main().catch(err => {
    console.error("E2E tests failed:", err);
    process.exit(1);
});
