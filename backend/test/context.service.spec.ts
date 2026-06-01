import { describe, expect, it } from "vitest";
import { messagePartContextText, snapshotMessageContextText } from "../src/modules/hub/services/context.service";

describe("messagePartContextText", () => {
  it("keeps diff metadata content when a diff part is pinned", () => {
    const text = messagePartContextText({
      id: "diff-1",
      type: "diff",
      title: "src/app.ts",
      metadata: {
        path: "src/app.ts",
        changeType: "modified",
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    });

    expect(text).toContain("type: diff");
    expect(text).toContain("path: src/app.ts");
    expect(text).toContain("changeType: modified");
    expect(text).toContain("patch:\n@@ -1 +1 @@\n-old\n+new");
  });

  it("keeps deployment identifiers when a deploy status part is pinned", () => {
    const text = messagePartContextText({
      id: "deploy_status",
      type: "deploy_status",
      title: "静态站点完成",
      url: "https://preview.example",
      metadata: {
        deploymentId: "deploy-1",
        status: "completed",
        target: "static",
        commitSha: "abcdef123456",
        sourceArchiveUrl: "https://github.com/acme/app/archive/abcdef123456.zip",
      },
    });

    expect(text).toContain("deploymentId: deploy-1");
    expect(text).toContain("status: completed");
    expect(text).toContain("target: static");
    expect(text).toContain("commitSha: abcdef123456");
    expect(text).toContain("sourceArchiveUrl: https://github.com/acme/app/archive/abcdef123456.zip");
  });
});

describe("snapshotMessageContextText", () => {
  it("adds code part summaries to recent message context", () => {
    const text = snapshotMessageContextText({
      role: "assistant",
      agentId: 12,
      contentText: "已生成组件。",
      contentJson: {
        parts: [
          {
            id: "code-1",
            type: "code",
            title: "Button.tsx",
            language: "tsx",
            text: "export function Button() {\n  return <button>Save</button>;\n}",
          },
        ],
      },
    });

    expect(text).toContain("assistant:12: 已生成组件。");
    expect(text).toContain("code part 1, language: tsx, title: Button.tsx");
    expect(text).toContain("export function Button()");
  });

  it("does not add file previews or diff patches to recent message context", () => {
    const text = snapshotMessageContextText({
      role: "assistant",
      contentText: "请查看产物。",
      contentJson: {
        parts: [
          {
            id: "file-1",
            type: "file",
            text: "FILE_PREVIEW_SHOULD_NOT_ENTER_RECENT",
            metadata: { textPreview: "TEXT_PREVIEW_SHOULD_NOT_ENTER_RECENT" },
          },
          {
            id: "diff-1",
            type: "diff",
            metadata: {
              patch: "@@ -1 +1 @@\n-DIFF_SHOULD_NOT_ENTER_RECENT\n+new",
              beforeContent: "BEFORE_SHOULD_NOT_ENTER_RECENT",
              afterContent: "AFTER_SHOULD_NOT_ENTER_RECENT",
            },
          },
        ],
      },
    });

    expect(text).toContain("assistant: 请查看产物。");
    expect(text).not.toContain("FILE_PREVIEW_SHOULD_NOT_ENTER_RECENT");
    expect(text).not.toContain("TEXT_PREVIEW_SHOULD_NOT_ENTER_RECENT");
    expect(text).not.toContain("DIFF_SHOULD_NOT_ENTER_RECENT");
    expect(text).not.toContain("BEFORE_SHOULD_NOT_ENTER_RECENT");
    expect(text).not.toContain("AFTER_SHOULD_NOT_ENTER_RECENT");
  });
});
