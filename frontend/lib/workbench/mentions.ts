import type { AgentInstanceDto, AgentTemplateDto } from "@agenthub/shared";
import type { MentionMatch } from "./types";

export function findActiveMention(text: string, caret: number): MentionMatch | null {
  const beforeCaret = text.slice(0, caret);
  const at = beforeCaret.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(beforeCaret[at - 1])) return null;

  const query = beforeCaret.slice(at + 1);
  if (!/^[a-zA-Z0-9_-]*$/.test(query)) return null;
  return { start: at, end: caret, query };
}

export function filterMentionCandidates(agents: AgentInstanceDto[], query: string) {
  const normalized = query.toLowerCase();
  if (!normalized) return agents;
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().startsWith(normalized) ||
      String(agent.id).startsWith(normalized),
  );
}

export function filterInviteTemplates(templates: AgentTemplateDto[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return templates;
  const tokens = normalized.split(/\s+/);
  return templates.filter((tpl) => {
    const target = `${tpl.name} ${tpl.description} ${tpl.id}`.toLowerCase();
    return tokens.every((token) => fuzzyIncludes(target, token));
  });
}

export function parseMentionedAgentIds(text: string, agents: AgentInstanceDto[]) {
  const byToken = new Map<string, number>();
  for (const agent of agents) {
    byToken.set(agent.name.toLowerCase(), agent.id);
    byToken.set(String(agent.id), agent.id);
  }

  const ids = new Set<number>();
  for (const match of text.matchAll(/@([a-zA-Z0-9_-]+)/g)) {
    const id = byToken.get(match[1].toLowerCase());
    if (id) ids.add(id);
  }
  return [...ids];
}

function fuzzyIncludes(target: string, query: string) {
  if (target.includes(query)) return true;
  let queryIndex = 0;
  for (const char of target) {
    if (char === query[queryIndex]) queryIndex++;
    if (queryIndex === query.length) return true;
  }
  return false;
}
