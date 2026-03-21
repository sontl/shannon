import fs from 'fs';
import { parseWorkflowLog, parseAgentLog } from './src/lib/parsers.js';

const workflowText = fs.readFileSync('./src/sample-data/workflow.log', 'utf8');
const wfEvents = parseWorkflowLog(workflowText);

const agentFiles = fs.readdirSync('./src/sample-data/agents');
const agts = {};
for (const file of agentFiles) {
  if (file.endsWith('.log')) {
    const text = fs.readFileSync(`./src/sample-data/agents/${file}`, 'utf8');
    const agentId = file.replace('.log', '');
    agts[agentId] = { id: agentId, ...parseAgentLog(text) };
  }
}

let currentPhase = 'unknown';
for (const e of wfEvents) {
  if (e.level === 'PHASE' && e.message.startsWith('Starting:')) {
    currentPhase = e.message.split('Starting:')[1].trim();
    console.log(`[PHASE] -> ${currentPhase}`);
  } else if (e.level === 'AGENT' && e.message.includes(': Starting')) {
    const agentName = e.message.split(': Starting')[0].trim();
    const agtsArr = Object.values(agts);
    const agt = agtsArr.find(a => a.header?.agent === agentName);
    if (agt) {
      agt.header.phase = currentPhase;
      console.log(`[AGENT] Mapped ${agentName} to ${currentPhase}`);
    } else {
      console.log(`[AGENT LOG] header.agent values:`, agtsArr.map(a => a.header?.agent));
      console.log(`[AGENT] Failed to map '${agentName}' - Agent not found in agts object!`);
    }
  }
}

const unknownCount = Object.values(agts).filter(a => !a.header.phase || a.header.phase === 'unknown').length;
const totalEvents = Object.values(agts).reduce((sum, a) => sum + (a.events?.length || 0), 0);
console.log(`Total agents: ${Object.keys(agts).length}, Unknown phase: ${unknownCount}, Total events: ${totalEvents}`);
