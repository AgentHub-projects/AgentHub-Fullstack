const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';
const DOC = 'NjEYdqF6woLnzJxK15kcm3PgnIe';

const r = execSync(`lark-cli docs +fetch --api-version v2 --doc ${DOC} --as user --json`, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
let content = JSON.parse(r).data.document.content;

// Fix 1: parameter table
const old1 = '<td vertical-align="top"><p>实际使用的模型（deepseek-v4-pro）上下文窗口为 1M，容量不是瓶颈。9000 这个值是基于信息密度的取舍：上下文太少（比如 2000）Agent 缺乏足够背景，太多（比如 50000）会稀释当前任务的关注度。9000 tokens 大约对应 6000-7000 个中文字符的上下文，经测试是信息量和信噪比之间的一个平衡点</p></td>';
const new1 = '<td vertical-align="top"><p>上下文快照的 token 上限</p></td>';
content = content.replace(old1, new1);

// Fix 2: "有无更优解" paragraph - remove it entirely (just keep the paragraph before and after)
const old2 = '<p><b>有无更优解？</b>可以改为可配置项而非硬编码，让不同场景（如代码生成 vs 文档写作）使用不同的预算值。当前硬编码 9000 是信息密度和信噪比的平衡点——实际使用的模型（deepseek-v4-pro）上下文窗口为 1M，容量充足，不需要自适应预算；但不同任务类型对上下文的需求不同，固定值在特定场景下可能不是最优。</p>';
const new2 = '';
content = content.replace(old2, new2);

const tmpFile = path.join(base, '_fix-budget3.xml');
fs.writeFileSync(tmpFile, content);

const ur = execSync(
  `cd "${base}" && lark-cli docs +update --api-version v2 --doc ${DOC} --command overwrite --content @_fix-budget3.xml --as user --json`,
  { encoding: 'utf8', maxBuffer: 50*1024*1024 }
);
console.log(JSON.parse(ur).ok ? 'OK' : 'FAIL');
