import * as assert from "assert";
import { findMains } from "../../src/run/kotlinMain";
import { findTests, parseSurefireReport, resultOf, surefireFilter } from "../../src/run/testModel";

const lines = (...l: string[]) => l.join("\n");

suite("run: main functions", () => {
    test("top-level main and the facade class the JVM starts", () => {
        const text = lines("package com.example.demo", "", "class App", "", "fun main(args: Array<String>) {", "    run()", "}");
        assert.deepStrictEqual(findMains(text, "/p/src/DemoApplication.kt"), [{ line: 4, mainClass: "com.example.demo.DemoApplicationKt" }]);
        assert.deepStrictEqual(findMains("suspend fun main() {}", "/p/my-tool.kt"), [{ line: 0, mainClass: "My_toolKt" }]);
        assert.deepStrictEqual(findMains(lines("@file:JvmName(\"Launcher\")", "package a", "fun main() {}"), "x.kt"), [{ line: 2, mainClass: "a.Launcher" }]);
    });

    test("not a main: members, other names, comments and strings", () => {
        const text = lines("class A {", "    fun main() {}", "}", "fun mainly() {}", "// fun main() {}", "val s = \"\"\"", "fun main() {}", "\"\"\"");
        assert.deepStrictEqual(findMains(text, "A.kt"), []);
    });
});

suite("run: tests", () => {
    const file = lines(
        "package dev.shop",
        "",
        "import org.junit.jupiter.api.Test",
        "",
        "class OrderTest {",
        "    @Test",
        "    fun `total of an order, with tax`() {}",
        "",
        "    @org.junit.jupiter.api.Test fun plain() {}",
        "    fun helper() {}",
        "",
        "    @Nested",
        "    inner class WhenEmpty {",
        "        @ParameterizedTest",
        "        @ValueSource(ints = [1, 2])",
        "        fun rejects(n: Int) {}",
        "    }",
        "}",
        "",
        "class Fixtures { fun make() {} }",
        "",
        "class OtherTest { @Test fun works() {} }",
    );

    test("classes with @Test functions, nested classes by their binary name", () => {
        assert.deepStrictEqual(findTests(file), [
            { fqName: "dev.shop.OrderTest", name: "OrderTest", line: 4, methods: [{ name: "total of an order, with tax", line: 6 }, { name: "plain", line: 8 }] },
            { fqName: "dev.shop.OrderTest$WhenEmpty", name: "OrderTest.WhenEmpty", line: 12, methods: [{ name: "rejects", line: 15 }] },
            { fqName: "dev.shop.OtherTest", name: "OtherTest", line: 21, methods: [{ name: "works", line: 21 }] },
        ]);
        assert.deepStrictEqual(findTests("fun main() {}"), []);
    });

    test("Surefire filter: classes, methods, and names with spaces or commas", () => {
        assert.strictEqual(surefireFilter([
            { fqName: "dev.shop.OrderTest", methods: ["total of an order, with tax", "plain"] }, { fqName: "dev.shop.OtherTest" },
        ]), "dev.shop.OrderTest#total?of?an?order??with?tax+plain,dev.shop.OtherTest");
    });

    test("Surefire report: passed, failed with message and line, skipped, parameterized", () => {
        const report = parseSurefireReport(lines(
            "<testsuite name=\"dev.shop.OrderTest\" tests=\"5\">",
            "  <testcase name=\"plain\" classname=\"dev.shop.OrderTest\" time=\"0.012\"/>",
            "  <testcase name=\"total of an order, with tax(TestInfo)\" classname=\"dev.shop.OrderTest\" time=\"0.1\">",
            "    <failure message=\"expected: &lt;3&gt; but was: &lt;4&gt;\" type=\"org.opentest4j.AssertionFailedError\"><![CDATA[org.opentest4j.AssertionFailedError: expected: <3> but was: <4>",
            "\tat org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:1145)",
            "\tat dev.shop.OrderTest.total of an order, with tax(OrderTest.kt:42)",
            "]]></failure>",
            "  </testcase>",
            "  <testcase name=\"ignored\" classname=\"dev.shop.OrderTest\" time=\"0\"><skipped/></testcase>",
            "  <testcase name=\"[1] 1\" classname=\"dev.shop.OrderTest\" time=\"0.5\"/>",
            "  <testcase name=\"rejects(int)[2]\" classname=\"dev.shop.OrderTest\" time=\"0.25\"><error message=\"boom\" type=\"x\"/></testcase>",
            "  <testcase name=\"rejects(int)[1]\" classname=\"dev.shop.OrderTest\" time=\"0.25\"/>",
            "</testsuite>"));
        assert.deepStrictEqual(report.get("plain"), { outcome: "passed", seconds: 0.012 });
        const failed = report.get("total of an order, with tax")!;
        assert.deepStrictEqual([failed.outcome, failed.line], ["failed", 41]);
        assert.ok(failed.message!.startsWith("org.opentest4j.AssertionFailedError: expected: <3> but was: <4>"), failed.message);
        assert.strictEqual(report.get("ignored")!.outcome, "skipped");
        const parameterized = resultOf(report, "rejects")!;
        assert.deepStrictEqual([parameterized.outcome, parameterized.message, parameterized.seconds], ["failed", "boom", 0.5]);
        assert.strictEqual(resultOf(report, "absent"), undefined);
    });
});
