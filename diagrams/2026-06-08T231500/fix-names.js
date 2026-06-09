const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';

const fixes = [
  // --- 数据库 ---
  {
    doc: 'AjcmdKuV9oEZlgxrDQbcXGGcnmd',
    label: '数据库',
    replacements: [
      ['使用 Unsupported("vector(1536)") 转义 + \\$queryRawUnsafe 执行原始 SQL。这是 TypeScript 生态的常见取舍——牺牲少部分 ORM 的完整性，换取 95% 查询的类型安全',
       '使用数据库原生 SQL 处理向量字段（ORM 不原生支持向量类型），其余查询走 ORM 保证类型安全'],
    ]
  },
  // --- 消息传输 ---
  {
    doc: 'Pdt7dkG2QofCcKxZeEmc7suXnvd',
    label: '消息传输',
    replacements: [
      ['<p>IDLE_TIMEOUT</p>', '<p>空闲超时</p>'],
      ['<p>RECOVERY_TIMEOUT</p>', '<p>重试超时</p>'],
      ['通过统一事件总线（HubEventService）分发', '通过统一的事件处理层分发'],
    ]
  },
  // --- 前端 ---
  {
    doc: 'FhJ8dBqYqoM2cexFqRccOROjn7b',
    label: '前端',
    replacements: [
      ['通过 EventStreamBuffer 将 Socket.IO 增量事件组装为时间线视图', '将 Socket.IO 收到的增量事件实时组装为时间线视图'],
    ]
  },
  // --- session记忆 ---
  {
    doc: 'NjEYdqF6woLnzJxK15kcm3PgnIe',
    label: 'session记忆',
    replacements: [
      ['<p>CONTEXT_TOKEN_BUDGET</p>', '<p>上下文快照预算</p>'],
      ['<p>RECENT_TOKEN_BUDGET</p>', '<p>近期消息预算</p>'],
      ['<p>RETRIEVAL_LIMIT</p>', '<p>语义检索上限</p>'],
      ['<p>SHORT_TERM_EVENT_LIMIT</p>', '<p>短期缓冲阈值（条数）</p>'],
      ['<p>SHORT_TERM_TOKEN_LIMIT</p>', '<p>短期缓冲阈值（字符数）</p>'],
    ]
  },
  // --- prompt设计 ---
  {
    doc: 'Rii0dWHMZopmOVxjFB3cMUTunI0',
    label: 'prompt设计',
    replacements: [
      ['CONTEXT_TOKEN_BUDGET=9000', '总量上限为 9000 tokens'],
      ['CONTEXT_RECENT_TOKEN_BUDGET=4800', '近期对话预算为 4800 tokens'],
      ['通过 ContextSnapshot 的 selectWithinBudget 算法，系统自动选择最重要的上下文', '系统按优先级自动选择最重要的上下文'],
      ['renderContextPrompt 输出可复现', '输出的上下文文本可复现'],
    ]
  },
];

for (const page of fixes) {
  console.log(`Processing ${page.label}...`);
  const r = execSync(`lark-cli docs +fetch --api-version v2 --doc ${page.doc} --as user --json`, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
  let content = JSON.parse(r).data.document.content;

  for (const [old, news] of page.replacements) {
    content = content.replace(old, news);
  }

  const tmpFile = path.join(base, `_fix-${page.label}.xml`);
  fs.writeFileSync(tmpFile, content);

  const ur = execSync(`cd "${base}" && lark-cli docs +update --api-version v2 --doc ${page.doc} --command overwrite --content @_fix-${page.label}.xml --as user --json`, { encoding: 'utf8', maxBuffer: 50*1024*1024 });
  console.log(JSON.parse(ur).ok ? '  OK' : '  FAIL');
}

console.log('Done');
