const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';
const DOC = 'Rii0dWHMZopmOVxjFB3cMUTunI0';

const r = execSync(`lark-cli docs +fetch --api-version v2 --doc ${DOC} --as user --json`, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
const content = JSON.parse(r).data.document.content;

const oldP = '<p><b>第一层 — 身份声明：</b>"你是 AgentHub 下的一个工作 Agent，当前运行在完整模式/增量模式"。这层告诉 Agent 它处在什么框架中、应该以什么姿态处理后续内容。完整模式和增量模式的标注让 Agent 知道是否需要认真阅读上下文——完整模式下上下文是新的需要仔细看，增量模式下它已经知道背景只需要关注新任务。</p>';

const newP = '<p><b>第一层 — 身份声明（每次都发）：</b>Agent 收到的第一行永远是 "# AgentHub 任务分派 (模式名)"，再加上一句 "请基于以下会话上下文和用户请求完成当前任务"。完整模式和增量模式只是括号里的模式名不同。这一层的目的主要是告诉 Agent 它当前以什么角色运行，以及标注当前的运行模式——模式名对下游 Agent 有实际意义：看到 bootstrap 就知道下面会有大段上下文需要消化，看到 incremental 就知道可以直接关注当前任务。注意在增量模式下，"请基于以下会话上下文" 这句话落在指令中但其实下面并没有上下文——这是一个未被条件分支处理的小瑕疵，对 Agent 行为影响不大所以保留了。</p>';

const fixed = content.replace(oldP, newP);
const tmpFile = path.join(base, '_fix-layer1.xml');
fs.writeFileSync(tmpFile, fixed);

const ur = execSync(
  `cd "${base}" && lark-cli docs +update --api-version v2 --doc ${DOC} --command overwrite --content @_fix-layer1.xml --as user --json`,
  { encoding: 'utf8', maxBuffer: 50*1024*1024 }
);
console.log(JSON.parse(ur).ok ? 'OK' : 'FAIL');
