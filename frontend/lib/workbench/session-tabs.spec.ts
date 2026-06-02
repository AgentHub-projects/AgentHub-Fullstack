import { describe, expect, it } from "vitest";
import {
  EMPTY_SESSION_TABS,
  activateSessionTab,
  closeSessionTab,
  markSessionTabUpdated,
  openSessionTab,
} from "./session-tabs";

describe("session tab state", () => {
  it("opens and activates sessions in order", () => {
    const first = activateSessionTab(EMPTY_SESSION_TABS, "session-1");
    const second = activateSessionTab(first, "session-2");

    expect(second.openIds).toEqual(["session-1", "session-2"]);
    expect(second.activeId).toBe("session-2");
  });

  it("marks only background opened sessions as unread", () => {
    const state = activateSessionTab(openSessionTab(activateSessionTab(EMPTY_SESSION_TABS, "session-1"), "session-2"), "session-1");

    expect(markSessionTabUpdated(state, "session-1").unreadIds).toEqual([]);
    expect(markSessionTabUpdated(state, "session-2").unreadIds).toEqual(["session-2"]);
    expect(markSessionTabUpdated(state, "session-3").unreadIds).toEqual([]);
  });

  it("clears unread on activation and chooses a neighbor when closing active tab", () => {
    const withUnread = markSessionTabUpdated(
      activateSessionTab(openSessionTab(activateSessionTab(EMPTY_SESSION_TABS, "session-1"), "session-2"), "session-1"),
      "session-2",
    );

    expect(activateSessionTab(withUnread, "session-2").unreadIds).toEqual([]);
    expect(closeSessionTab(activateSessionTab(withUnread, "session-2"), "session-2")).toMatchObject({
      openIds: ["session-1"],
      activeId: "session-1",
      unreadIds: [],
    });
  });
});
