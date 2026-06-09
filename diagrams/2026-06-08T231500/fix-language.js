const { execSync } = require('child_process');
const fs = require('fs');

const fixes = [
  {
    doc: 'AjcmdKuV9oEZlgxrDQbcXGGcnmd',
    label: '数据库',
    old: '<p><b>AgentHub 的核心优势</b>',
    new: '<p><b>取舍小结</b>'
  },
  {
    doc: 'Pdt7dkG2QofCcKxZeEmc7suXnvd',
    label: '消息传输',
    old: '<p><b>AgentHub 优势</b>：ACP 标准协议 + WebSocket 全双工实现了真正的实时交互体验——用户看到 Agent 逐字输出，并可随时取消运行。相比 AutoGPT 的轮询模式和 CrewAI 的同步阻塞，AgentHub 的 IM 聊天体验更加流畅。</p>',
    new: '<p><b>小结</b>：ACP 协议 + WebSocket 双工实现了逐字流式推送和实时取消，相比 AutoGPT 的轮询和 CrewAI 的同步阻塞，推送粒度更细、取消响应更快。这是协议选择带来的效果差异，并非独有能力——任何 WebSocket + 流式协议的实现都可以达到类似效果。</p>'
  },
  {
    doc: 'NjEYdqF6woLnzJxK15kcm3PgnIe',
    label: 'session记忆维护',
    old: '<p><b>AgentHub 优势</b>：相比 MemGPT 的复杂分页机制和 LangChain 的编码门槛，AgentHub 的记忆系统对用户完全透明——不需要任何配置，Agent 自动积累、检索和应用上下文。结构化 JSON 记忆也比纯文本总结更易于下游消费。</p>',
    new: '<p><b>小结</b>：选择增量结构化提取而非全量总结，长会话中成本保持 O(1)。代价是依赖 LLM 提取质量，偶尔提取不到有效信息时本轮记忆为空。MemGPT 的分层记忆和 LangChain 的可插拔 Memory 后端提供了更灵活但更复杂的方案，这里选择了简单和自动化的路线。</p>'
  },
  {
    doc: 'Rii0dWHMZopmOVxjFB3cMUTunI0',
    label: 'prompt的设计',
    old: '<p><b>AgentHub 优势</b>：Prompt 构建过程完全透明——ContextSnapshot 存储在数据库中可审计，renderContextPrompt 生成的文本可直接查看。相比 OpenAI Assistants 的黑盒 Thread 管理，AgentHub 让开发者能确切知道每次发送给 Agent 的 Prompt 内容。</p>',
    new: '<p><b>小结</b>：Prompt 构建过程可审计——ContextSnapshot 存储在数据库中可查询，renderContextPrompt 输出可复现。OpenAI Assistants 的 Thread 管理对开发者是黑盒但有更完善的自动管理，LangChain Hub 的模板系统则提供更灵活的定制。这里选择了透明优先，代价是需要自己处理上下文裁剪和模式切换。</p>'
  }
];

for (const fix of fixes) {
  console.log(`Processing ${fix.label}...`);

  // Fetch current content
  const fetchResult = execSync(
    `lark-cli docs +fetch --api-version v2 --doc ${fix.doc} --as user --json`,
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  const fetchJson = JSON.parse(fetchResult);
  let content = fetchJson.data.document.content;

  if (!content.includes(fix.old)) {
    console.log(`  SKIP: old text not found`);
    continue;
  }

  // Replace exact string
  const cleaned = content.replace(fix.old, fix.new);

  // Write to temp file
  const tmpFile = `_fix-${fix.label}.xml`;
  fs.writeFileSync(tmpFile, cleaned);

  // Overwrite
  const updateResult = execSync(
    `lark-cli docs +update --api-version v2 --doc ${fix.doc} --command overwrite --content @${tmpFile} --as user --json`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  const updateJson = JSON.parse(updateResult);
  if (updateJson.ok) {
    console.log(`  OK rev=${updateJson.data?.document?.revision_id || '?'}`);
  } else {
    console.log(`  WARN: ${updateJson.error?.message || 'unknown'}`);
  }
}

console.log('Done');
