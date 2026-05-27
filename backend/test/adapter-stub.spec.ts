import { describe, expect, it } from "vitest";
import { StubController } from "../src/controllers/stub.controller";

describe("Downstream adapter - StubController", () => {
  const controller = new StubController();

  describe("Conversations", () => {
    it("GET /api/conversations returns empty list", () => {
      expect(controller.listConversations()).toEqual({ items: [] });
    });

    it("GET /api/conversations/:id/messages returns empty messages", () => {
      const result = controller.listMessages("conv-test");
      expect(result).toEqual({ conversationId: "conv-test", items: [] });
    });

    it("POST /api/conversations/:id/messages echoes the posted body", () => {
      const body = { role: "user", content: "hello world" };
      const result = controller.createMessage("conv-test", body);
      expect(result.conversationId).toBe("conv-test");
      expect(result.message).toEqual(body);
    });
  });

  describe("Agents", () => {
    it("GET /api/agents returns a Claude agent entry", () => {
      const result = controller.listAgents();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: "claude", name: "Claude", provider: "anthropic", role: "coding-agent",
      });
    });
  });

  describe("Pinned Context", () => {
    it("GET /api/pinned-context returns empty list", () => {
      expect(controller.listPinnedContext()).toEqual({ items: [] });
    });

    it("POST /api/pinned-context echoes the posted body", () => {
      const body = { key: "config", value: { theme: "dark" } };
      expect(controller.createPinnedContext(body)).toEqual({ item: body });
    });
  });

  describe("Artifacts", () => {
    it("GET /api/artifacts returns empty list", () => {
      expect(controller.listArtifacts()).toEqual({ items: [] });
    });
  });

  describe("Code Apply", () => {
    it("POST /api/code-apply returns not-implemented stub", () => {
      const body = { diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new" };
      const result = controller.applyCode(body);
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("not implemented");
      expect(result.request).toEqual(body);
    });
  });
});
