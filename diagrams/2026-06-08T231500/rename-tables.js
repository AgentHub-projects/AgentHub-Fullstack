const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';

// Map: code table name → functional description
const map = [
  [/\bContextItem\b/g, '上下文条目'],
  [/\bContextEmbedding\b/g, '向量嵌入记录'],
  [/\bContextSnapshot\b/g, '上下文快照'],
  [/\bSessionMemory\b/g, '会话记忆'],
  [/\bLongTermSummary\b/g, '长期摘要记录'],
  [/\bContextUpdateJob\b/g, '上下文更新任务'],
  [/\bArtifact\b/g, '制品'],
  [/\bAgentRun\b/g, '运行记录'],
  [/\bAgentEvent\b/g, 'Agent事件'],
  [/\bFileChange\b/g, '文件变更记录'],
  [/\bSessionAgent\b/g, '会话成员'],
  [/\bMessage\b/g, '消息'],
  [/\bSession\b/g, '会话'],
  [/\bcontext_items\b/g, '上下文条目表'],
  [/\bcontext_embeddings\b/g, '向量嵌入表'],
  [/\bcontext_snapshots\b/g, '上下文快照表'],
  [/\bsession_memories\b/g, '会话记忆表'],
  [/\bsession_agents\b/g, '会话成员表'],
];

// Pages to fix (NOT database page)
const pages = [
  { doc: 'Pdt7dkG2QofCcKxZeEmc7suXnvd', label: '消息传输' },
  { doc: 'FhJ8dBqYqoM2cexFqRccOROjn7b', label: '前端' },
  { doc: 'NjEYdqF6woLnzJxK15kcm3PgnIe', label: 'session' },
  { doc: 'Rii0dWHMZopmOVxjFB3cMUTunI0', label: 'prompt' },
];

for (const page of pages) {
  console.log(`Processing ${page.label}...`);
  const r = execSync(`lark-cli docs +fetch --api-version v2 --doc ${page.doc} --as user --json`, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
  let content = JSON.parse(r).data.document.content;

  for (const [re, replacement] of map) {
    content = content.replace(re, replacement);
  }

  const tmpFile = path.join(base, `_rename-${page.label}.xml`);
  fs.writeFileSync(tmpFile, content);

  const ur = execSync(`cd "${base}" && lark-cli docs +update --api-version v2 --doc ${page.doc} --command overwrite --content @_rename-${page.label}.xml --as user --json`, { encoding: 'utf8', maxBuffer: 50*1024*1024 });
  console.log('  ' + (JSON.parse(ur).ok ? 'OK' : 'FAIL'));
}

console.log('Done');
