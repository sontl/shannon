export function parseSessionJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse session.json', e);
    return null;
  }
}

export function parseWorkflowLog(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const events = [];
  
  lines.forEach(line => {
    // Basic structured parser for workflow.log
    // Lines might be like: [2026-03-21T14:30:50.123Z] [INFO] [pre-recon] Starting phase
    const match = line.match(/^\[(.*?)\]\s+\[(.*?)\]\s+(?:\[(.*?)\]\s+)?(.*)$/);
    if (match) {
      let ts = match[1];
      if (!ts.includes('Z')) {
        ts = ts.replace(' ', 'T') + 'Z';
      }
      events.push({
        timestamp: ts,
        level: match[2],
        context: match[3] || 'system',
        message: match[4]
      });
    } else {
      events.push({ raw: line });
    }
  });
  
  return events;
}

export function parseAgentLog(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const agentData = {
    header: {},
    events: [],
    success: false,
    duration_ms: 0,
    cost_usd: 0
  };

  let inHeader = false;
  
  lines.forEach(line => {
    if (line.startsWith('===')) {
      inHeader = !inHeader;
      return;
    }
    
    if (inHeader) {
      if (line.includes(':')) {
        const [key, ...rest] = line.split(':');
        agentData.header[key.trim().toLowerCase()] = rest.join(':').trim();
      }
    } else if (line.startsWith('{')) {
      inHeader = false;
      try {
        const event = JSON.parse(line);
        agentData.events.push(event);
        
        if (event.type === 'agent_end') {
          agentData.success = event.data.success;
          agentData.duration_ms = event.data.duration_ms;
          agentData.cost_usd = event.data.cost_usd;
        }
      } catch (e) {
        // Not JSON or partial
      }
    }
  });
  
  return agentData;
}

export function parseDeliverable(filename, text) {
  if (filename.endsWith('.json')) {
    try {
      return { type: 'json', data: JSON.parse(text) };
    } catch (e) {
      return { type: 'json', data: null, error: 'Failed to parse JSON' };
    }
  }
  return { type: 'markdown', data: text };
}

export function parsePrompt(filename, text) {
  return { type: 'markdown', data: text };
}
