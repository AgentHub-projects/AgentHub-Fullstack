const fs = require('fs');
const { execSync } = require('child_process');

const pages = [
  { doc: 'AjcmdKuV9oEZlgxrDQbcXGGcnmd', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-db.txt', label: '数据库' },
  { doc: 'Pdt7dkG2QofCcKxZeEmc7suXnvd', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-msg.txt', label: '消息传输' },
  { doc: 'FhJ8dBqYqoM2cexFqRccOROjn7b', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-fe.txt', label: '前端连接沙箱' },
  { doc: 'NjEYdqF6woLnzJxK15kcm3PgnIe', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-sm.txt', label: 'session记忆维护' },
  { doc: 'Rii0dWHMZopmOVxjFB3cMUTunI0', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-pt.txt', label: 'prompt的设计' },
  { doc: 'EchddDl46od9WoxD1fCcngjqndf', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-prod.txt', label: '产品设计文档' },
];

function shellEscape(str) {
  // Replace \ with \\, then " with \", then $ with \$, then ` with \`
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

for (const page of pages) {
  const content = fs.readFileSync(page.file, 'utf8').replace(/\r?\n/g, '').trim();
  const escaped = shellEscape(content);
  const cmd = `lark-cli docs +update --api-version v2 --doc ${page.doc} --command append --content "${escaped}" --as user --json`;

  console.log(`Updating: ${page.label} (${content.length} chars)`);
  try {
    const result = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const r = JSON.parse(result);
    console.log(`OK: ${page.label} rev=${r.data?.document?.revision_id || '?'}`);
  } catch(e) {
    console.error(`FAIL ${page.label}: ${e.stderr ? e.stderr.toString().substring(0, 400) : e.message}`);
  }
}
