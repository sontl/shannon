import React, { useMemo } from 'react';
import { useData } from '../lib/dataStore';

const PHASE_COLORS = [
  'var(--accent-primary)',
  'var(--accent-secondary)',
  'var(--color-warning)',
  'var(--accent-tertiary, #9b51e0)',
  'var(--color-success)',
  'var(--color-info, #2d9cdb)'
];

export default function WorkflowTimeline({ onSelectAgent }) {
  const { sessionData, workflowEvents, agents } = useData();

  const timelineData = useMemo(() => {
    if (!sessionData || !workflowEvents || workflowEvents.length === 0) return null;
    const sessionStart = new Date(sessionData.session?.createdAt || sessionData.start_time).getTime();
    const sessionEnd = new Date(sessionData.session?.completedAt || sessionData.end_time || Date.now()).getTime();
    const totalDuration = sessionEnd - sessionStart;

    const phasesMap = [];
    let currentPhaseObj = null;

    workflowEvents.forEach(e => {
      if (e.level === 'PHASE') {
        if (e.message.startsWith('Starting:')) {
          const name = e.message.split('Starting:')[1].trim();
          currentPhaseObj = {
            name,
            start: new Date(e.timestamp).getTime(),
            end: sessionEnd, // defaults to end until completed
            agentsMap: {}
          };
          phasesMap.push(currentPhaseObj);
        } else if (e.message.startsWith('Completed:')) {
          const name = e.message.split('Completed:')[1].trim();
          const phase = phasesMap.find(p => p.name === name);
          if (phase) {
            phase.end = new Date(e.timestamp).getTime();
          }
        }
      } else if (e.level === 'AGENT') {
        if (e.message.includes(': Starting')) {
          const agentName = e.message.split(': Starting')[0].trim();
          if (currentPhaseObj) {
            if (!currentPhaseObj.agentsMap[agentName]) {
              currentPhaseObj.agentsMap[agentName] = {
                name: agentName,
                start: new Date(e.timestamp).getTime(),
                end: sessionEnd
              };
            }
          }
        } else if (e.message.includes(': Completed')) {
          const agentName = e.message.split(': Completed')[0].trim();
          // Find the last phase this agent was seen in
          const phase = [...phasesMap].reverse().find(p => p.agentsMap[agentName]);
          if (phase && phase.agentsMap[agentName]) {
            phase.agentsMap[agentName].end = new Date(e.timestamp).getTime();
          }
        }
      }
    });

    // Map the structures to calculate relative percentages and bind the actual agent IDs
    return phasesMap.map((phase, pIndex) => {
      const startRel = ((phase.start - sessionStart) / totalDuration) * 100;
      let widthRel = ((phase.end - phase.start) / totalDuration) * 100;
      if (widthRel < 0.5) widthRel = 0.5;
      
      const phaseColor = PHASE_COLORS[pIndex % PHASE_COLORS.length];

      const phaseAgents = Object.values(phase.agentsMap).map(a => {
        const aStartRel = ((a.start - sessionStart) / totalDuration) * 100;
        let aWidthRel = ((a.end - a.start) / totalDuration) * 100;
        if (aWidthRel < 0.5) aWidthRel = 0.5;

        // Try to link back to actual loaded agent to display success/failure
        const actualLogAgent = Object.values(agents).find(loadedAgt => loadedAgt.header?.agent === a.name);
        
        return {
          ...a,
          startRel: aStartRel,
          widthRel: aWidthRel,
          id: actualLogAgent ? actualLogAgent.id : a.name,
          success: actualLogAgent ? actualLogAgent.success : true,
          color: phaseColor
        };
      });

      return {
        ...phase,
        startRel,
        widthRel,
        color: phaseColor,
        agents: phaseAgents
      };
    });
  }, [sessionData, workflowEvents, agents]);

  if (!timelineData) return <div style={{ padding: '48px', color: 'var(--text-secondary)' }}>Loading or no timeline data...</div>;

  return (
    <div className="animate-fade-in" style={{ paddingBottom: '48px' }}>
      <header style={{ marginBottom: '40px' }}>
        <h1 style={{ fontSize: '32px', marginBottom: '8px' }}>Workflow Timeline</h1>
        <p style={{ color: 'var(--text-secondary)' }}>Chronological view of phase and agent execution</p>
      </header>

      <div className="glass-panel" style={{ padding: '32px', position: 'relative', minHeight: '400px' }}>
        {timelineData.map((phase, i) => (
          <div key={`${phase.name}-${i}`} style={{ marginBottom: '32px', position: 'relative' }}>
            {/* Phase background band */}
            <div style={{ 
               position: 'absolute', 
               left: `${phase.startRel}%`, 
               width: `${phase.widthRel}%`, 
               height: '100%', 
               background: 'rgba(255,255,255,0.02)',
               borderLeft: `1px dashed ${phase.color}`,
               borderRight: `1px dashed ${phase.color}`,
               zIndex: 0
            }} />
            
            <h3 style={{ fontSize: '14px', marginBottom: '16px', position: 'relative', zIndex: 1, color: 'var(--text-secondary)', marginLeft: phase.startRel > 10 ? `${phase.startRel}%` : '0%' }}>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: phase.color, marginRight: '8px' }}></span>
              {phase.name}
            </h3>
            
            <div style={{ position: 'relative', zIndex: 1 }}>
              {phase.agents.map((agent, j) => (
                <div 
                  key={`${agent.name}-${j}`} 
                  style={{ 
                    height: '32px', 
                    marginBottom: '8px', 
                    position: 'relative',
                    cursor: 'pointer'
                  }}
                  onClick={() => onSelectAgent(agent.id)}
                  title={`${agent.name} - ${agent.success ? 'Success' : 'Failed'}`}
                >
                  <div style={{
                    position: 'absolute',
                    left: `${agent.startRel}%`,
                    width: `${agent.widthRel}%`,
                    height: '100%',
                    background: agent.color,
                    opacity: agent.success ? 0.9 : 0.4,
                    border: agent.success ? 'none' : '1px solid var(--color-error)',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 8px',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    fontSize: '11px',
                    color: '#fff',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    transition: 'all 0.2s'
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'scaleY(1.1)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.opacity = agent.success ? '0.9' : '0.4'; e.currentTarget.style.transform = 'scaleY(1)'; }}
                  >
                    {agent.widthRel > 5 && agent.name}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Timeline Axis */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '40px', paddingTop: '16px', borderTop: '1px solid var(--border-light)', color: 'var(--text-tertiary)', fontSize: '12px' }}>
          <span>Start</span>
          <span>End</span>
        </div>
      </div>
    </div>
  );
}
