import { describe, expect, it } from "vitest";
import { parseClaudeStreamLine } from "../src/services/agent-runner.service";

describe("parseClaudeStreamLine", () => {
  it("extracts plain text from Claude stream-json shapes", () => {
    expect(parseClaudeStreamLine(JSON.stringify({ text: "hello" }))).toBe("hello");
    expect(parseClaudeStreamLine(JSON.stringify({ delta: { text: " world" } }))).toBe(" world");
    expect(parseClaudeStreamLine(JSON.stringify({ content: [{ type: "text", text: "!" }] }))).toBe("!");
  });

  it("keeps non-json output as text", () => {
    expect(parseClaudeStreamLine("raw text")).toBe("raw text");
    expect(parseClaudeStreamLine("")).toBeUndefined();
  });
});
