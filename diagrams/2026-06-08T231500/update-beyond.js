const fs = require('fs');
const { execSync } = require('child_process');

function shellEscape(str) {
  return str.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

const content = fs.readFileSync('D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-beyond.txt', 'utf8').replace(/\r?\n/g, '').trim();
const escaped = shellEscape(content);
const cmd = `lark-cli docs +update --api-version v2 --doc EchddDl46od9WoxD1fCcngjqndf --command append --content "${escaped}" --as user --json`;

console.log(`Updating 产品设计文档 (${content.length} chars)...`);
try {
  const result = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const r = JSON.parse(result);
  console.log(`OK rev=${r.data?.document?.revision_id || '?'}`);
} catch(e) {
  console.error('FAIL: ' + (e.stderr ? e.stderr.toString().substring(0, 500) : e.message));
}
