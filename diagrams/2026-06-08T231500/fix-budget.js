const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';
const DOC = 'NjEYdqF6woLnzJxK15kcm3PgnIe';

const r = execSync(`lark-cli docs +fetch --api-version v2 --doc ${DOC} --as user --json`, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
const content = JSON.parse(r).data.document.content;

const old = '<td vertical-align="top"><p>考虑主流模型 8K-128K 上下文窗口。9000 为上下文部分预算，加上 System Prompt(~2000) + 用户消息 + 工具结果，总 token 约 12K-15K，适合 deepseek-chat 等模型</p></td>';
const news = '<td vertical-align="top"><p>实际使用的模型（deepseek-v4-pro）上下文窗口为 1M，容量不是瓶颈。9000 这个值是基于信息密度的取舍：上下文太少（比如 2000）Agent 缺乏足够背景，太多（比如 50000）会稀释当前任务的关注度。9000 tokens 大约对应 6000-7000 个中文字符的上下文，经测试是信息量和信噪比之间的一个平衡点</p></td>';

const fixed = content.replace(old, news);
const tmpFile = path.join(base, '_fix-budget.xml');
fs.writeFileSync(tmpFile, fixed);

const ur = execSync(
  `cd "${base}" && lark-cli docs +update --api-version v2 --doc ${DOC} --command overwrite --content @_fix-budget.xml --as user --json`,
  { encoding: 'utf8', maxBuffer: 50*1024*1024 }
);
console.log(JSON.parse(ur).ok ? 'OK' : 'FAIL');
