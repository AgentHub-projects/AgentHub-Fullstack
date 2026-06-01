import { describe, expect, it } from "vitest";
import { messagePartContextText } from "../src/modules/hub/services/context.service";

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
