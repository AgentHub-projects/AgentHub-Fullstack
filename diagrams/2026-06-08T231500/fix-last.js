const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';

const fixes = [
  {
    doc: 'Pdt7dkG2QofCcKxZeEmc7suXnvd', label: '消息',
    old: '<h3>为什么使用 HubEventService 集中处理事件？</h3>',
    news: '<h3>为什么集中处理所有事件？</h3>'
  },
  {
    doc: 'FhJ8dBqYqoM2cexFqRccOROjn7b', label: '前端',
    old: 'EventStreamBuffer.buildEventGroups()',
    news: '将零散事件组装为结构化时间线'
  },
  {
    doc: 'Rii0dWHMZopmOVxjFB3cMUTunI0', label: 'prompt',
    old: '<p>selectWithinBudget 算法采用<b>优先级贪婪选择</b>：</p>',
    news: '<p>预算分配采用<b>优先级选择</b>策略：</p>'
  },
];

for (const f of fixes) {
  console.log(`Processing ${f.label}...`);
  const r = execSync(`lark-cli docs +fetch --api-version v2 --doc ${f.doc} --as user --json`, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
  const content = JSON.parse(r).data.document.content.replace(f.old, f.news);
  const tmpFile = path.join(base, `_fix-${f.label}-2.xml`);
  fs.writeFileSync(tmpFile, content);
  const ur = execSync(`cd "${base}" && lark-cli docs +update --api-version v2 --doc ${f.doc} --command overwrite --content @_fix-${f.label}-2.xml --as user --json`, { encoding: 'utf8', maxBuffer: 50*1024*1024 });
  console.log(JSON.parse(ur).ok ? '  OK' : '  FAIL');
}
