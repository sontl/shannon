import React, { useState } from 'react';
import { useData } from '../lib/dataStore';
import { Terminal, Clock, DollarSign, CheckCircle, XCircle, Code, MessageSquare, Brain } from 'lucide-react';

const TurnEvent = ({ event, index }) => {
  const [expanded, setExpanded] = useState(false);
  
  if (event.type === 'agent_start' || event.type === 'agent_end') return null;
  
  let parsedContent = null;
  let textContent = '';
  
  try {
    if (typeof event.data?.content === 'string' && event.data.content.trim().startsWith('{')) {
      parsedContent = JSON.parse(event.data.content);
    } else {
      textContent = event.data?.content || '';
    }
  } catch(e) {
    textContent = event.data?.content || '';
  }

  const isTool = parsedContent?.type === 'tool_use';
  const isThought = parsedContent?.type === 'thinking';
  const isText = !isTool && !isThought;
  
  return (
    <div style={{
      marginBottom: '16px',
      borderLeft: `2px solid ${isTool ? 'var(--accent-secondary)' : isThought ? 'var(--text-tertiary)' : 'var(--accent-primary)'}`,
      paddingLeft: '16px',
      position: 'relative'
    }}>
      <div style={{
        position: 'absolute',
        left: '-9px',
        top: '0',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: 'var(--bg-base)',
        border: `2px solid ${isTool ? 'var(--accent-secondary)' : isThought ? 'var(--text-tertiary)' : 'var(--accent-primary)'}`
      }} />
      
      <div 
        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded(!expanded)}
      >
        {isTool ? <Code size={16} color="var(--accent-secondary)" /> : 
         isThought ? <Brain size={16} color="var(--text-tertiary)" /> : 
         <MessageSquare size={16} color="var(--accent-primary)" />}
         
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {isTool ? `Tool: ${parsedContent.name}` : isThought ? 'Agent Thought' : 'LLM Response'}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </div>
      
      <div style={{ 
        background: 'var(--bg-surface)', 
        borderRadius: 'var(--radius-md)', 
        padding: '12px',
        fontSize: '13px',
        color: isThought ? 'var(--text-secondary)' : 'var(--text-primary)',
        maxHeight: expanded ? 'none' : '200px',
        overflow: 'hidden',
        position: 'relative'
      }}>
        {isThought && <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-sans)', margin: 0 }}>{parsedContent.thinking}</pre>}
        {isTool && <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--accent-secondary)', margin: 0 }}>{JSON.stringify(parsedContent.input, null, 2)}</pre>}
        {isText && <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-sans)', margin: 0 }}>{textContent || JSON.stringify(parsedContent, null, 2)}</pre>}
        
        {!expanded && (
          <div style={{
            position: 'absolute',
            bottom: 0, left: 0, right: 0, height: '40px',
            background: 'linear-gradient(transparent, var(--bg-base))',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: '4px',
            cursor: 'pointer', color: 'var(--accent-primary)', fontSize: '12px'
          }} onClick={(e) => { e.stopPropagation(); setExpanded(true); }}>
            Expand
          </div>
        )}
      </div>
    </div>
  );
};

export default function AgentView({ agentId }) {
  const { agents } = useData();
  const agent = agents[agentId];

  if (!agent) return <div>Agent not found</div>;

  return (
    <div className="animate-fade-in" style={{ paddingBottom: '48px' }}>
      <header className="glass-panel" style={{ padding: '32px', marginBottom: '40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '28px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Terminal color="var(--accent-primary)" size={28} />
            {agentId}
          </h1>
          <p style={{ color: 'var(--text-secondary)', display: 'flex', gap: '16px' }}>
            <span>Phase: {agent.header?.phase}</span>
            <span>Model: {agent.header?.model}</span>
          </p>
        </div>
        
        <div style={{ display: 'flex', gap: '24px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>Status</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: agent.success ? 'var(--color-success)' : 'var(--color-error)' }}>
              {agent.success ? <CheckCircle size={18} /> : <XCircle size={18} />}
              {agent.success ? 'Success' : 'Failure'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>Duration</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Clock size={16} color="var(--text-secondary)" />
              {agent.duration_ms ? (agent.duration_ms / 1000).toFixed(1) + 's' : '-'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>Cost</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <DollarSign size={16} color="var(--text-secondary)" />
              {agent.cost_usd ? agent.cost_usd.toFixed(4) : '-'}
            </div>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <h3 style={{ marginBottom: '24px', color: 'var(--text-secondary)', fontSize: '16px' }}>Execution Timeline</h3>
        {agent.events.map((event, i) => (
          <TurnEvent key={i} event={event} index={i} />
        ))}
      </div>
    </div>
  );
}
