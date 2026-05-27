import { describe, expect, it, vi } from "vitest";
import {
  DownstreamError,
  DownstreamErrorCode,
  InMemoryTransport,
  NorthAdapter
} from "../src/downstream";

describe("NorthAdapter (pending request map)", () => {
  it("routes responses back to the original requester by id", async () => {
    const { a, b } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a);

    b.onFrame((frame) => {
      // Respond to whatever request comes in with the method name as result.
      if ("method" in frame) {
        void b.send({ jsonrpc: "2.0", id: frame.id, result: { method: frame.method } });
      }
    });

    const [r1, r2] = await Promise.all([
      adapter.request<{ method: string }>("a"),
      adapter.request<{ method: string }>("b")
    ]);
    expect(r1).toEqual({ method: "a" });
    expect(r2).toEqual({ method: "b" });
    expect(adapter.pendingCount).toBe(0);
  });

  it("rejects pending requests when the transport closes (no leak)", async () => {
    const { a } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a, { requestTimeoutMs: 0 });

    const inflight = adapter.request("never");
    await Promise.resolve();
    expect(adapter.pendingCount).toBe(1);

    await a.close(new Error("network died"));

    await expect(inflight).rejects.toBeInstanceOf(Error);
    expect(adapter.pendingCount).toBe(0);
  });

  it("rejects with a typed timeout error when no response arrives", async () => {
    const { a } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a, { requestTimeoutMs: 5 });

    const err = await adapter.request("slow").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownstreamError);
    expect((err as DownstreamError).code).toBe(DownstreamErrorCode.Timeout);
    expect(adapter.pendingCount).toBe(0);
  });

  it("propagates JSON-RPC error responses as Remote errors", async () => {
    const { a, b } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a);

    b.onFrame((frame) => {
      if ("method" in frame) {
        void b.send({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32000, message: "boom" }
        });
      }
    });

    const err = await adapter.request("explode").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownstreamError);
    expect((err as DownstreamError).code).toBe(DownstreamErrorCode.Remote);
    expect((err as DownstreamError).message).toContain("boom");
  });

  it("dispatches server-initiated requests to the registered handler", async () => {
    const { a, b } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a);
    const handler = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    adapter.setServerRequestHandler(handler);

    let received: unknown;
    b.onFrame((frame) => {
      if ("result" in frame || "error" in frame) {
        received = frame;
      }
    });

    await b.send({
      jsonrpc: "2.0",
      id: 99,
      method: "session/event",
      params: { hello: "world" }
    });
    // Yield until the handler responds.
    for (let i = 0; i < 20 && !received; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(handler).toHaveBeenCalledWith("session/event", { hello: "world" });
    expect(received).toMatchObject({
      id: 99,
      result: { method: "session/event", params: { hello: "world" } }
    });
  });

  it("returns a JSON-RPC error to the server when the handler throws", async () => {
    const { a, b } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a);
    adapter.setServerRequestHandler(async () => {
      throw new Error("persist failed");
    });

    let received: unknown;
    b.onFrame((frame) => {
      if ("result" in frame || "error" in frame) received = frame;
    });
    await b.send({ jsonrpc: "2.0", id: 7, method: "session/event", params: {} });
    for (let i = 0; i < 20 && !received; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(received).toMatchObject({ id: 7, error: { message: "persist failed" } });
  });
});
