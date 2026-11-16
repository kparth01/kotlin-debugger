import * as fs from "fs";
import * as path from "path";
import { parseHeader } from "../completion/imports";
import { mask } from "../completion/inference";

export interface TestMethod { name: string; line: number }

export interface TestClass {
    /** Binary name as Surefire wants it: `com.example.OrderTest`, `com.example.Outer$Inner`. */
    fqName: string;
    /** `OrderTest`, `Outer.Inner`. */
    name: string;
    line: number;
    methods: TestMethod[];
}

export type TestOutcome = "passed" | "failed" | "skipped";

export interface TestResult {
    outcome: TestOutcome;
    seconds: number;
    /** Failure message and stack trace. */
    message?: string;
    /** `File.kt:42` from the first stack frame in the test class, when there is one. */
    line?: number;
}

const TEST_ANNOTATION = /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/g;

/** Test classes of a Kotlin file: classes with at least one function annotated `@Test` (JUnit 4/5, kotlin.test). */
export function findTests(text: string): TestClass[] {
    const masked = mask(text);
    const pkg = parseHeader(text).packageName;
    const lineOf = (offset: number) => { let line = 0; for (let i = 0; i < offset; i++) { if (text.charCodeAt(i) === 10) { line++; } } return line; };
    // class bodies, outermost first
    const bodies: Array<{ name: string; start: number; end: number; at: number; parent?: number }> = [];
    for (const m of masked.matchAll(/\b(?:class|object)\s+([A-Za-z_]\w*)/g)) {
        const open = masked.indexOf("{", m.index! + m[0].length);
        if (open < 0) { continue; }
        // a declaration without a body before the next one (`class A`, `class B { }`)
        const between = masked.slice(m.index! + m[0].length, open);
        if (/\b(?:class|object|interface|fun|val|var)\b/.test(between.replace(/\([^)]*\)/g, ""))) { continue; }
        let depth = 0;
        let end = masked.length;
        for (let i = open; i < masked.length; i++) {
            if (masked[i] === "{") { depth++; } else if (masked[i] === "}" && --depth === 0) { end = i; break; }
        }
        bodies.push({ name: m[1], start: open, end, at: m.index! });
    }
    bodies.forEach((b, i) => {
        for (let k = i - 1; k >= 0; k--) {
            if (bodies[k].start < b.at && bodies[k].end > b.end) { b.parent = k; break; }
        }
    });
    const path_ = (i: number, separator: string): string => bodies[i].parent === undefined ? bodies[i].name : `${path_(bodies[i].parent!, separator)}${separator}${bodies[i].name}`;
    const classes = new Map<number, TestClass>();
    for (const m of masked.matchAll(TEST_ANNOTATION)) {
        const rest = text.slice(m.index!, m.index! + 600);
        const fun = /\bfun\s+(?:<[^>]*>\s*)?(`[^`\n]+`|[A-Za-z_]\w*)\s*\(/.exec(rest);
        if (!fun) { continue; }
        const at = m.index! + fun.index;
        let owner = -1;
        bodies.forEach((b, i) => { if (b.start < at && b.end > at && (owner < 0 || b.start > bodies[owner].start)) { owner = i; } });
        if (owner < 0) { continue; }
        let cls = classes.get(owner);
        if (!cls) {
            const binary = path_(owner, "$");
            cls = { fqName: pkg ? `${pkg}.${binary}` : binary, name: path_(owner, "."), line: lineOf(bodies[owner].at), methods: [] };
            classes.set(owner, cls);
        }
        const name = fun[1].replace(/`/g, "");
        if (!cls.methods.some(method => method.name === name)) { cls.methods.push({ name, line: lineOf(at) }); }
    }
    return [...classes.values()].sort((a, b) => a.line - b.line);
}

/**
 * The value of Surefire's `-Dtest=`: `com.a.OrderTest#create+cancel,com.a.OtherTest`. Characters of a method name
 * that mean something in the pattern (spaces, commas, `+`, ...) become the single-character wildcard `?`.
 */
export function surefireFilter(tests: Array<{ fqName: string; methods?: string[] }>): string {
    return tests.map(t => t.methods?.length ? `${t.fqName}#${t.methods.map(m => m.replace(/[^\w$]/g, "?")).join("+")}` : t.fqName).join(",");
}

const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (all, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
        : ({ lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" } as Record<string, string>)[e] ?? all);

/** Results of one `TEST-*.xml` Surefire report: method name (without parameter list) → result. */
export function parseSurefireReport(xml: string): Map<string, TestResult> {
    const results = new Map<string, TestResult>();
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const attribute = (name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? "");
        // `name(TestInfo)` and `name()` are the method `name`; `[1] x` of a parameterized test stays with its method below
        const name = attribute("name").replace(/\([^()]*\)$/, "");
        const body = m[2] ?? "";
        const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(body);
        const result: TestResult = { outcome: failure ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed", seconds: parseFloat(attribute("time")) || 0 };
        if (failure) {
            const text = decode((failure[3] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim();
            const message = decode(/\bmessage="([^"]*)"/.exec(failure[2] ?? failure[5] ?? "")?.[1] ?? "");
            result.message = text || message || "Test failed";
            const simple = attribute("classname").split(".").pop()!.split("$")[0];
            const frame = new RegExp(`\\(${simple.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.kt:(\\d+)\\)`).exec(text) ?? /\(\w+\.kt:(\d+)\)/.exec(text);
            if (frame) { result.line = parseInt(frame[1], 10) - 1; }
        }
        const earlier = results.get(name);
        // several invocations of one method (parameterized, repeated): a failure wins
        if (!earlier || (earlier.outcome !== "failed" && result.outcome === "failed")) { results.set(name, { ...result, seconds: result.seconds + (earlier?.seconds ?? 0) }); }
    }
    return results;
}

/** Reads `target/surefire-reports/TEST-<class>.xml` of a class; `undefined` when the class did not run. */
export function readSurefireReport(projectDir: string, fqName: string): Map<string, TestResult> | undefined {
    try {
        return parseSurefireReport(fs.readFileSync(path.join(projectDir, "target", "surefire-reports", `TEST-${fqName}.xml`), "utf8"));
    } catch {
        return undefined;
    }
}

/** The result of a method in a report: by name, or by the invocations of a parameterized test that start with it. */
export function resultOf(report: Map<string, TestResult>, method: string): TestResult | undefined {
    const exact = report.get(method);
    if (exact) { return exact; }
    let combined: TestResult | undefined;
    for (const [name, result] of report) {
        if (!name.startsWith(method)) { continue; }
        const seconds = result.seconds + (combined?.seconds ?? 0);
        // a failed invocation decides the result of the method
        combined = !combined || (combined.outcome !== "failed" && result.outcome === "failed") ? { ...result, seconds } : { ...combined, seconds };
    }
    return combined;
}
