const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';
const DOC = 'Rii0dWHMZopmOVxjFB3cMUTunI0';

const r = execSync(`lark-cli docs +fetch --api-version v2 --doc ${DOC} --as user --json`, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
const content = JSON.parse(r).data.document.content;

const oldText = '<p>权衡：incremental 模式下 Agent 看不到完整上下文（只有历史对话通过 ACP 协议维护），对于需要跨消息回忆的任务可能不够。但如果 session 活跃超时（1小时），系统会自动回退到 bootstrap。</p>';
const newText = '<p>两种模式的本质区别在于<b>谁在维护上下文</b>。下游 Agent（Claude Code / OpenCode）是一个长期运行的进程实例，它自己就是完整的 AI Agent，有自己的对话记忆和上下文管理能力。增量模式下，AgentHub 只发送用户的新消息，不做任何上下文注入——因为下游 Agent 在上一轮运行中已经积累了完整的上下文，它记得之前的所有对话、文件变更和当前任务状态。完整模式下，AgentHub 重建并发送一个上下文快照——因为下游 Agent 可能已经重启或断连，它的内存上下文不可靠。不是增量模式\"丢失了\"上下文，而是增量模式下上下文<b>本来就由下游 Agent 自己维护</b>，AgentHub 不需要重复发送。</p>';

const fixed = content.replace(oldText, newText);
const tmpFile = path.join(base, '_fix-prompt.xml');
fs.writeFileSync(tmpFile, fixed);

const ur = execSync(
  `cd "${base}" && lark-cli docs +update --api-version v2 --doc ${DOC} --command overwrite --content @_fix-prompt.xml --as user --json`,
  { encoding: 'utf8', maxBuffer: 50*1024*1024 }
);
const uj = JSON.parse(ur);
console.log(uj.ok ? 'OK' : 'FAIL: ' + JSON.stringify(uj.error || uj));
