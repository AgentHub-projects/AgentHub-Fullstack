const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const base = 'D:/agent/AgentHub-Fullstack/diagrams/2026-06-08T231500';

// Read prefix XML files
const msgPrefix = fs.readFileSync(path.join(base, 'msg-full.xml'), 'utf8').replace(/\r?\n/g, '').trim();
const msgDeep = fs.readFileSync(path.join(base, 'content-msg-idle-deep.txt'), 'utf8').replace(/\r?\n/g, '').trim();
const msgFull = msgPrefix + msgDeep;
const msgFile = path.join(base, '_msg-full.xml');
fs.writeFileSync(msgFile, msgFull);

console.log('Overwriting 消息传输 via @file (' + msgFull.length + ' chars)...');
try {
  const r = execSync(`lark-cli docs +update --api-version v2 --doc Pdt7dkG2QofCcKxZeEmc7suXnvd --command overwrite --content @${msgFile} --as user --json`, { encoding: 'utf8', maxBuffer: 50*1024*1024 });
  console.log('OK 消息传输 rev=' + JSON.parse(r).data?.document?.revision_id);
} catch(e) { console.error('FAIL 消息传输: ' + (e.stderr ? e.stderr.toString().substring(0,300) : e.message)); }

// prompt的设计 - build full XML
const ptPrefix = fs.readFileSync(path.join(base, 'pt-prefix.xml'), 'utf8').replace(/\r?\n/g, '').trim();
const ptDeep = fs.readFileSync(path.join(base, 'content-pt-internal-deep.txt'), 'utf8').replace(/\r?\n/g, '').trim();
const ptFull = ptPrefix + ptDeep;
const ptFile = path.join(base, '_pt-full.xml');
fs.writeFileSync(ptFile, ptFull);

console.log('Overwriting prompt的设计 via @file (' + ptFull.length + ' chars)...');
try {
  const r = execSync(`lark-cli docs +update --api-version v2 --doc Rii0dWHMZopmOVxjFB3cMUTunI0 --command overwrite --content @${ptFile} --as user --json`, { encoding: 'utf8', maxBuffer: 50*1024*1024 });
  console.log('OK prompt的设计 rev=' + JSON.parse(r).data?.document?.revision_id);
} catch(e) { console.error('FAIL prompt的设计: ' + (e.stderr ? e.stderr.toString().substring(0,300) : e.message)); }
