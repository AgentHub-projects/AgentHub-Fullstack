const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';
const DOC = 'NjEYdqF6woLnzJxK15kcm3PgnIe';

const r = execSync(`lark-cli docs +fetch --api-version v2 --doc ${DOC} --as user --json`, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
const content = JSON.parse(r).data.document.content;

const old = '<p><b>有无更优解？</b>可以引入自适应 token 预算——根据模型上下文窗口动态调整 BUDGET 值。当前硬编码 9000 是为了兼容 deepseek-chat（64K 窗口）与 gpt-4o（128K 窗口）的下限。未来可通过检测模型 max_tokens 自动计算。</p>';
const news = '<p><b>有无更优解？</b>可以改为可配置项而非硬编码，让不同场景（如代码生成 vs 文档写作）使用不同的预算值。当前硬编码 9000 是信息密度和信噪比的平衡点——实际使用的模型（deepseek-v4-pro）上下文窗口为 1M，容量充足，不需要自适应预算；但不同任务类型对上下文的需求不同，固定值在特定场景下可能不是最优。</p>';

const fixed = content.replace(old, news);
const tmpFile = path.join(base, '_fix-budget2.xml');
fs.writeFileSync(tmpFile, fixed);

const ur = execSync(
  `cd "${base}" && lark-cli docs +update --api-version v2 --doc ${DOC} --command overwrite --content @_fix-budget2.xml --as user --json`,
  { encoding: 'utf8', maxBuffer: 50*1024*1024 }
);
console.log(JSON.parse(ur).ok ? 'OK' : 'FAIL');
