import * as path from "path";
import { parseHeader } from "../completion/imports";
import { mask } from "../completion/inference";

export interface KotlinMain {
    /** Line of `fun main`. */
    line: number;
    /** The class the JVM starts: the file facade, `com.example.DemoApplicationKt`. */
    mainClass: string;
}

/** Top-level `fun main` functions of a Kotlin file and the JVM class each compiles to. */
export function findMains(text: string, fileName: string): KotlinMain[] {
    const masked = mask(text);
    const header = parseHeader(text);
    const jvmName = /^\s*@file\s*:\s*(?:kotlin\.jvm\.)?JvmName\s*\(\s*"([^"]+)"/m.exec(text)?.[1];
    const base = path.basename(fileName).replace(/\.kts?$/, "");
    // Kotlin's facade name: the file name as an identifier, first letter in upper case, plus `Kt`.
    const facade = jvmName ?? `${(base[0]?.toUpperCase() ?? "") + base.slice(1).replace(/[^\w$]/g, "_")}Kt`;
    const mainClass = header.packageName ? `${header.packageName}.${facade}` : facade;
    const mains: KotlinMain[] = [];
    masked.split("\n").forEach((line, index) => {
        if (/^(?:(?:public|internal|suspend)\s+)*fun\s+main\s*\(/.test(line)) { mains.push({ line: index, mainClass }); }
    });
    return mains;
}
