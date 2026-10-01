import * as path from "path";
import Mocha from "mocha";

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: "tdd", color: false, timeout: 300_000 });
    mocha.addFile(path.resolve(__dirname, `${process.env.KDA_E2E_SUITE ?? "springBoot"}.e2e.js`));
    return new Promise((resolve, reject) => {
        mocha.run(failures => (failures > 0 ? reject(new Error(`${failures} E2E test(s) failed`)) : resolve()));
    });
}
