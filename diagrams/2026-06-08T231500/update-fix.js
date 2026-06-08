const fs = require('fs');
const { execSync } = require('child_process');

function shellEscape(str) {
  return str.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

// Replace old 1-hour section in 消息传输 with corrected version
const msgNew = fs.readFileSync('D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-msg-idle-v2.txt', 'utf8').replace(/\r?\n/g, '').trim();
const msgEscaped = shellEscape(msgNew);
const msgCmd = `lark-cli docs +update --api-version v2 --doc Pdt7dkG2QofCcKxZeEmc7suXnvd --mode replace_all --selection-by-title "一小时空闲断连的设计缘由" --markdown "${msgEscaped}" --as user --json`;

console.log('Fixing 消息传输...');
try {
  const result = execSync(msgCmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const r = JSON.parse(result);
  console.log(`OK 消息传输 rev=${r.data?.document?.revision_id || '?'}`);
} catch(e) {
  console.error(`FAIL 消息传输: ${e.stderr ? e.stderr.toString().substring(0, 500) : e.message}`);
}

// Replace old ACP fields section in prompt的设计 with internal prompt content
const ptNew = fs.readFileSync('D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500/content-pt-internal.txt', 'utf8').replace(/\r?\n/g, '').trim();
const ptEscaped = shellEscape(ptNew);
const ptCmd = `lark-cli docs +update --api-version v2 --doc Rii0dWHMZopmOVxjFB3cMUTunI0 --mode replace_all --selection-by-title "Prompt 结构化字段的设计意图" --markdown "${ptEscaped}" --as user --json`;

console.log('Fixing prompt的设计...');
try {
  const result = execSync(ptCmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const r = JSON.parse(result);
  console.log(`OK prompt的设计 rev=${r.data?.document?.revision_id || '?'}`);
} catch(e) {
  console.error(`FAIL prompt的设计: ${e.stderr ? e.stderr.toString().substring(0, 500) : e.message}`);
}
