const fs = require('fs');
const { execSync } = require('child_process');

function shellEscape(str) {
  return str.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

const pages = [
  { doc: 'Pdt7dkG2QofCcKxZeEmc7suXnvd', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-msg-idle.txt', label: '消息传输' },
  { doc: 'NjEYdqF6woLnzJxK15kcm3PgnIe', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-sm-stateless.txt', label: 'session记忆维护' },
  { doc: 'Rii0dWHMZopmOVxjFB3cMUTunI0', file: 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-pt-fields.txt', label: 'prompt的设计' },
];

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
