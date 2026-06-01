import { describe, expect, it } from "vitest";
import {
  deriveTitle,
  parseDeploymentCommandTarget,
  referencedPartText,
} from "../src/modules/hub/services/hub-session.service";

describe("HubSessionService deployment command parsing", () => {
  it("maps chat deployment commands to deployment targets", () => {
    expect(parseDeploymentCommandTarget("部署")).toBe("static");
    expect(parseDeploymentCommandTarget("请部署到容器")).toBe("container");
    expect(parseDeploymentCommandTarget("源码打包")).toBe("source_archive");
    expect(parseDeploymentCommandTarget("deploy container")).toBe("container");
    expect(parseDeploymentCommandTarget("帮我解释一下部署流程，这不是触发部署")).toBeNull();
  });
});

describe("HubSessionService title derivation", () => {
  it("uses the first direct-chat user message for the default title", () => {
    expect(deriveTitle("新单聊", "用 Claude Code 写一个 React 组件", { mode: "direct", titleSource: "auto" }))
      .toBe("用 Claude Code 写一个 React 组件");
  });

  it("does not overwrite manual or already-derived titles", () => {
    expect(deriveTitle("手动标题", "新的用户消息", { titleSource: "manual" })).toBe("手动标题");
    expect(deriveTitle("首条消息标题", "第二条消息", { titleSource: "auto" })).toBe("首条消息标题");
  });
});

describe("HubSessionService part references", () => {
  it("builds reference text for non-text message parts", () => {
    const text = referencedPartText({
      parts: [
        {
          id: "file_1",
          type: "file",
          title: "需求文档.pdf",
          url: "https://oss.example/requirements.pdf",
          metadata: { mimeType: "application/pdf", sizeBytes: 1024 },
        },
      ],
    }, "file_1");

    expect(text).toContain("type: file");
    expect(text).toContain("title: 需求文档.pdf");
    expect(text).toContain("url: https://oss.example/requirements.pdf");
    expect(text).toContain("mimeType: application/pdf");
  });

  it("keeps code/text part content in references", () => {
    expect(referencedPartText({
      parts: [{ id: "code_1", type: "code", language: "ts", text: "const ok = true;" }],
    }, "code_1")).toContain("const ok = true;");
  });

  it("keeps diff metadata patch in part references", () => {
    const text = referencedPartText({
      parts: [
        {
          id: "diff_1",
          type: "diff",
          title: "src/app.ts",
          metadata: {
            path: "src/app.ts",
            changeType: "modified",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        },
      ],
    }, "diff_1");

    expect(text).toContain("path: src/app.ts");
    expect(text).toContain("changeType: modified");
    expect(text).toContain("patch:\n@@ -1 +1 @@\n-old\n+new");
  });
});
