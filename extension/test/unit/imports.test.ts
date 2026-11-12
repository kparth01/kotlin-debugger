import * as assert from "assert";
import {
    ASCII_LAYOUT, compareImports, escapeName, importPlan, ImportPlanner, INTELLIJ_LAYOUT, parseHeader, withImports,
} from "../../src/completion/imports";
import { organizeImports } from "../../src/completion/organizeImports";

/** Applies the planned insertion to `text`, as the editor would. */
function withImport(text: string, fqName: string, layout?: string): string {
    const plan = importPlan(text, fqName, layout);
    if (!plan) { return text; }
    const lines = text.split("\n");
    const offset = lines.slice(0, plan.line).reduce((n, l) => n + l.length + 1, 0) + plan.character;
    return text.slice(0, offset) + plan.newText + text.slice(offset);
}

const lines = (...l: string[]) => l.join("\n");

suite("imports: header", () => {
    test("package, imports with star and alias, first declaration", () => {
        const h = parseHeader(lines(
            "package com.example.web",
            "",
            "import a.b.C",
            "import a.b.*",
            "import a.b.D as E // why",
            "import a.`fun`.F;",
            "",
            "class X",
        ));
        assert.strictEqual(h.packageName, "com.example.web");
        assert.strictEqual(h.packageLine, 0);
        assert.deepStrictEqual(h.imports, [
            { name: "a.b.C", star: false, alias: undefined, line: 2 },
            { name: "a.b", star: true, alias: undefined, line: 3 },
            { name: "a.b.D", star: false, alias: "E", line: 4 },
            { name: "a.fun.F", star: false, alias: undefined, line: 5 },
        ]);
        assert.strictEqual(h.bodyLine, 7);
    });

    test("an import inside a string below the header is not an import", () => {
        const h = parseHeader(lines("package p", "", "val s = \"\"\"", "import not.Real", "\"\"\""));
        assert.strictEqual(h.imports.length, 0);
        assert.strictEqual(h.bodyLine, 2);
    });

    test("shebang, licence comment and multi-line @file: annotation", () => {
        const h = parseHeader(lines(
            "/*",
            " * Licence. import fake.Name",
            " */",
            "@file:JvmName(",
            "    \"Util\"",
            ")",
            "@file:Suppress(\"unused\")",
            "",
            "package p",
            "import a.B",
        ));
        assert.strictEqual(h.preambleLine, 6);
        assert.strictEqual(h.packageLine, 8);
        assert.deepStrictEqual(h.imports.map(i => i.name), ["a.B"]);
    });

    test("a comment attached to the first declaration belongs to the body", () => {
        const h = parseHeader(lines("// licence", "", "/** Doc. */", "// more", "class X"));
        assert.strictEqual(h.bodyLine, 2);
    });
});

suite("imports: order", () => {
    const sorted = (names: string[], layout?: string) =>
        names.map(n => {
            const [name, alias] = n.split(" as ");
            return name.endsWith(".*") ? { name: name.slice(0, -2), star: true, alias } : { name, alias };
        }).sort((a, b) => compareImports(a, b, layout))
            .map(i => `${i.name}${"star" in i && i.star ? ".*" : ""}${i.alias ? ` as ${i.alias}` : ""}`);

    test("IntelliJ layout: others, java, javax, kotlin, aliases", () => {
        assert.deepStrictEqual(
            sorted(["kotlin.math.max", "java.util.UUID", "org.b.C as D", "javax.inject.Inject", "kotlinx.coroutines.delay", "com.a.B", "java.io.File"]),
            ["com.a.B", "kotlinx.coroutines.delay", "java.io.File", "java.util.UUID", "javax.inject.Inject", "kotlin.math.max", "org.b.C as D"]);
    });

    test("ASCII order inside a group: upper case before lower case, star first", () => {
        assert.deepStrictEqual(
            sorted(["a.b.itemCount", "a.b.Order", "a.b.*", "a.B", "a.b.c.D"]),
            ["a.B", "a.b.*", "a.b.Order", "a.b.c.D", "a.b.itemCount"]);
    });

    test("ASCII layout is one block", () => {
        assert.deepStrictEqual(
            sorted(["kotlin.math.max", "java.util.UUID", "com.a.B", "org.b.C as D"], ASCII_LAYOUT),
            ["com.a.B", "java.util.UUID", "kotlin.math.max", "org.b.C as D"]);
    });

    test("custom layout from .editorconfig: the most specific entry wins", () => {
        assert.deepStrictEqual(
            sorted(["com.acme.app.X", "com.acme.Y", "org.z.Z", "android.A"], "android.**,com.acme.app.**,*,com.acme.**"),
            ["android.A", "com.acme.app.X", "org.z.Z", "com.acme.Y"]);
    });
});

suite("imports: insertion", () => {
    const controller = lines(
        "package com.example.demo.web",
        "",
        "import com.example.demo.domain.Order",
        "import com.example.demo.service.OrderService",
        "import org.springframework.http.HttpStatus",
        "import org.springframework.web.bind.annotation.GetMapping",
        "import java.math.BigDecimal",
        "",
        "class OrderController",
        "",
    );

    test("lands in sorted position between existing imports", () => {
        const plan = importPlan(controller, "org.springframework.util.StringUtils")!;
        assert.deepStrictEqual(plan, { line: 5, character: 0, newText: "import org.springframework.util.StringUtils\n" });
    });

    test("lower-case names sort after classes of the same package", () => {
        assert.strictEqual(importPlan(controller, "com.example.demo.domain.itemCount")!.line, 3);
    });

    test("before the first import, and into the java / kotlin groups", () => {
        assert.strictEqual(importPlan(controller, "arrow.core.Either")!.line, 2);
        assert.strictEqual(importPlan(controller, "java.io.File")!.line, 6);
        assert.strictEqual(importPlan(controller, "java.util.UUID")!.line, 7);
        assert.strictEqual(importPlan(controller, "kotlin.math.max")!.line, 7);
        assert.strictEqual(importPlan(controller, "kotlinx.coroutines.delay")!.line, 4);
    });

    test("ASCII layout keeps java between com and org", () => {
        const text = lines("import com.a.B", "import org.c.D", "", "class X");
        assert.strictEqual(importPlan(text, "java.util.UUID", ASCII_LAYOUT)!.line, 1);
        assert.strictEqual(importPlan(text, "java.util.UUID", INTELLIJ_LAYOUT)!.line, 2);
    });

    test("unsorted imports: after the last one that sorts before the new import", () => {
        const text = lines("import a.A", "import z.Z", "import b.B", "", "class X");
        assert.strictEqual(importPlan(text, "c.C")!.line, 3);
    });

    test("nothing to add: same import, star import, same package, default packages", () => {
        const text = lines("package p.q", "", "import a.B", "import c.*", "import d.E as F", "", "class X");
        assert.strictEqual(importPlan(text, "a.B"), undefined);
        assert.strictEqual(importPlan(text, "c.D"), undefined);
        assert.strictEqual(importPlan(text, "p.q.Y"), undefined);
        assert.strictEqual(importPlan(text, "kotlin.collections.List"), undefined);
        assert.strictEqual(importPlan(text, "kotlin.text.isBlank"), undefined);
        assert.strictEqual(importPlan(text, "java.lang.Math"), undefined);
        // an alias does not make the original name usable; subpackages are not covered by a star import
        assert.ok(importPlan(text, "d.E"));
        assert.ok(importPlan(text, "c.x.D"));
        assert.ok(importPlan(text, "kotlin.math.max"));
    });

    test("no imports yet: below the package, with blank lines around", () => {
        assert.strictEqual(withImport("package p\n\nclass X\n", "a.B"), "package p\n\nimport a.B\n\nclass X\n");
        assert.strictEqual(withImport("package p\nclass X\n", "a.B"), "package p\n\nimport a.B\n\nclass X\n");
        assert.strictEqual(withImport("package p\n", "a.B"), "package p\n\nimport a.B\n");
        assert.strictEqual(withImport("package p", "a.B"), "package p\n\nimport a.B");
    });

    test("no package: above the first declaration and its comment, below @file: annotations", () => {
        assert.strictEqual(withImport("class X\n", "a.B"), "import a.B\n\nclass X\n");
        assert.strictEqual(withImport("", "a.B"), "import a.B\n\n");
        assert.strictEqual(withImport("// licence\n\n/** Doc. */\nclass X\n", "a.B"), "// licence\n\nimport a.B\n\n/** Doc. */\nclass X\n");
        assert.strictEqual(withImport("@file:JvmName(\"U\")\n\nfun f() = 1\n", "a.B"), "@file:JvmName(\"U\")\n\nimport a.B\n\nfun f() = 1\n");
    });

    test("last import on the last line of a file without a final line break", () => {
        assert.strictEqual(withImport("import a.A", "b.B"), "import a.A\nimport b.B");
        assert.strictEqual(withImport("import b.B", "a.A"), "import a.A\nimport b.B");
    });

    test("Windows line endings are left alone", () => {
        assert.strictEqual(withImport("package p\r\n\r\nimport a.A\r\nimport c.C\r\n", "b.B"), "package p\r\n\r\nimport a.A\r\nimport b.B\nimport c.C\r\n");
    });

    test("keyword segments are escaped", () => {
        assert.strictEqual(escapeName("org.mockito.Mockito.when"), "org.mockito.Mockito.`when`");
        assert.strictEqual(importPlan("class X", "a.fun.B")!.newText, "import a.`fun`.B\n\n");
    });

    test("several imports at once: each in its place, already imported names are skipped", () => {
        const text = lines("package p", "", "import com.a.B", "import java.io.File", "", "class X", "");
        assert.strictEqual(
            withImports(text, ["java.util.UUID", "com.a.A", "kotlinx.coroutines.delay", "com.a.B", "java.io.Closeable", "com.a.A"]),
            lines("package p", "", "import com.a.A", "import com.a.B", "import kotlinx.coroutines.delay", "import java.io.Closeable",
                "import java.io.File", "import java.util.UUID", "", "class X", ""));
        assert.strictEqual(withImports("class X\n", ["b.B", "a.A"]), "import a.A\nimport b.B\n\nclass X\n");
    });

    test("explicit imports bind simple names (clash detection)", () => {
        const planner = new ImportPlanner(lines("import java.util.Date", "import a.b.Thing as Other", "import c.*"));
        assert.strictEqual(planner.explicitlyImported("Date"), "java.util.Date");
        assert.strictEqual(planner.explicitlyImported("Other"), "a.b.Thing");
        assert.strictEqual(planner.explicitlyImported("Thing"), undefined);
        assert.strictEqual(planner.explicitlyImported("c"), undefined);
    });
});

suite("imports: organize", () => {
    const apply = (text: string, layout?: string) => {
        const result = organizeImports(text, layout);
        if (!result) { return text; }
        const all = text.split("\n");
        return [...all.slice(0, result.startLine), ...(result.newText ? [result.newText] : []), ...all.slice(result.endLine + 1)].join("\n");
    };

    test("sorts by the layout, drops duplicates and unused imports", () => {
        const text = lines(
            "package p", "",
            "import java.util.UUID", "import org.b.Used", "import com.a.Unused", "import org.b.Used", "import kotlin.math.max",
            "import com.a.Thing as Other", "import com.c.*", "import com.a.ext", "",
            "fun f(u: Used): UUID = Other().ext(max(1, 2))", "");
        const result = organizeImports(text)!;
        assert.deepStrictEqual(result.removed, ["com.a.Unused"]);
        assert.strictEqual(apply(text), lines(
            "package p", "",
            "import com.a.ext", "import com.c.*", "import org.b.Used", "import java.util.UUID", "import kotlin.math.max", "import com.a.Thing as Other", "",
            "fun f(u: Used): UUID = Other().ext(max(1, 2))", ""));
    });

    test("kept although the name is not written: operators, delegates, destructuring, star imports, KDoc links", () => {
        const text = lines(
            "import a.b.component1", "import a.b.getValue", "import a.b.plus", "import a.c.*", "import a.d.Linked", "",
            "/** See [Linked]. */", "val x by lazy { 1 }", "");
        assert.strictEqual(organizeImports(text), undefined, "nothing to change");
    });

    test("an alias is used by its alias only", () => {
        const text = lines("import a.Thing as Other", "import b.Other as Thing", "", "val x = Other()", "");
        assert.deepStrictEqual(organizeImports(text)?.removed, ["b.Other as Thing"]);
    });

    test("comments inside the import block are left to the user", () => {
        assert.strictEqual(organizeImports(lines("import b.B", "// keep", "import a.A", "", "val x = A() to B()")), undefined);
    });

    test("already organized, or no imports", () => {
        assert.strictEqual(organizeImports(lines("import a.A", "import b.B", "", "val x = A() to B()")), undefined);
        assert.strictEqual(organizeImports("class X"), undefined);
    });
});
