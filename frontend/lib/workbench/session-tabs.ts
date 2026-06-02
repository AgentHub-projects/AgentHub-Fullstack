export interface SessionTabsState {
  openIds: string[];
  activeId: string | null;
  unreadIds: string[];
}

export const EMPTY_SESSION_TABS: SessionTabsState = {
  openIds: [],
  activeId: null,
  unreadIds: [],
};

export function openSessionTab(state: SessionTabsState, sessionId: string): SessionTabsState {
  if (state.openIds.includes(sessionId)) return state;
  return { ...state, openIds: [...state.openIds, sessionId] };
}

export function activateSessionTab(state: SessionTabsState, sessionId: string | null): SessionTabsState {
  if (!sessionId) return { ...state, activeId: null };
  const opened = openSessionTab(state, sessionId);
  return {
    ...opened,
    activeId: sessionId,
    unreadIds: opened.unreadIds.filter((id) => id !== sessionId),
  };
}

export function closeSessionTab(state: SessionTabsState, sessionId: string): SessionTabsState {
  const openIds = state.openIds.filter((id) => id !== sessionId);
  const activeId = state.activeId === sessionId ? openIds[openIds.length - 1] ?? null : state.activeId;
  return {
    openIds,
    activeId,
    unreadIds: state.unreadIds.filter((id) => id !== sessionId),
  };
}

export function markSessionTabUpdated(state: SessionTabsState, sessionId: string): SessionTabsState {
  if (state.activeId === sessionId || !state.openIds.includes(sessionId) || state.unreadIds.includes(sessionId)) {
    return state;
  }
  return { ...state, unreadIds: [...state.unreadIds, sessionId] };
}
