import React, { useMemo } from 'react';
import { useData } from '../lib/dataStore';
import { Activity, LayoutDashboard, Terminal, FileText, FileCode2, Command } from 'lucide-react';

export default function Sidebar({ currentView, setCurrentView, selectedItem, setSelectedItem }) {
  const { sessionData, agents, deliverables, prompts } = useData();

  // Group agents by phase
  const phases = useMemo(() => {
    const p = {};
    Object.values(agents).forEach(agent => {
      const phaseName = agent.header?.phase || 'unknown';
      if (!p[phaseName]) p[phaseName] = [];
      p[phaseName].push(agent);
    });
    return p;
  }, [agents]);

  const navItemStyle = (isActive) => ({
    display: 'flex',
    alignItems: 'center',
    padding: '10px 16px',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    backgroundColor: isActive ? 'var(--bg-surface-active)' : 'transparent',
    transition: 'all 0.2s',
    marginBottom: '4px',
    fontSize: '14px',
    fontWeight: isActive ? 500 : 400
  });

  return (
    <aside style={{ 
      width: 'var(--sidebar-width)', 
      backgroundColor: 'rgba(10, 14, 26, 0.95)',
      borderRight: '1px solid var(--border-light)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      backdropFilter: 'blur(20px)'
    }}>
      <div style={{ padding: '24px', borderBottom: '1px solid var(--border-light)' }}>
        <h2 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
          <Activity color="var(--accent-primary)" size={20} />
          Audit Viewer
        </h2>
        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px', paddingLeft: '28px' }}>
          By <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>Techvify</span>
        </div>
        {sessionData && (
          <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
            <div style={{ marginBottom: '4px' }}>Session: {sessionData.session_id?.split('-').pop()}</div>
            <div>URL: <a href={sessionData.web_url} target="_blank" rel="noreferrer">{sessionData.web_url}</a></div>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 12px' }}>
        <div style={{ marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-tertiary)', padding: '0 16px', marginBottom: '8px' }}>
            Overview
          </div>
          <div 
            style={navItemStyle(currentView === 'dashboard')} 
            onClick={() => setCurrentView('dashboard')}
          >
            <LayoutDashboard size={16} style={{ marginRight: '12px', opacity: 0.7 }} />
            Dashboard
          </div>
          <div 
            style={navItemStyle(currentView === 'workflow')} 
            onClick={() => setCurrentView('workflow')}
          >
            <Activity size={16} style={{ marginRight: '12px', opacity: 0.7 }} />
            Workflow Timeline
          </div>
        </div>

        <div style={{ marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-tertiary)', padding: '0 16px', marginBottom: '8px' }}>
            Phases & Agents
          </div>
          {Object.entries(phases).map(([phase, phaseAgents]) => (
            <div key={phase} style={{ marginBottom: '8px' }}>
              <div style={{ padding: '6px 16px', fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
                 {phase}
                 <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-tertiary)', background: 'var(--bg-surface)', padding: '2px 6px', borderRadius: '4px' }}>
                   {phaseAgents.length}
                 </span>
              </div>
              {phaseAgents.map(agent => (
                <div 
                  key={agent.id}
                  style={{
                    ...navItemStyle(currentView === 'agent' && selectedItem === agent.id),
                    paddingLeft: '32px'
                  }}
                  onClick={() => { setSelectedItem(agent.id); setCurrentView('agent'); }}
                >
                  <Terminal size={14} style={{ marginRight: '8px', opacity: 0.5 }} />
                  <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: agent.success ? 'var(--color-success)' : 'var(--color-error)', marginRight: '8px' }}></span>
                  {agent.id.replace(/^\d+_/, '')}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-tertiary)', padding: '0 16px', marginBottom: '8px' }}>
            Artifacts
          </div>
          <div style={navItemStyle(false)} onClick={() => {}}>
             <FileText size={16} style={{ marginRight: '12px', opacity: 0.7 }} />
             Deliverables ({deliverables.length})
             <div style={{ marginLeft: '16px', display: 'flex', flexDirection: 'column', width: '100%', marginTop: '8px' }}>
               {deliverables.map(d => (
                 <div key={d.path} 
                      onClick={(e) => { e.stopPropagation(); setSelectedItem(d.path); setCurrentView('deliverables'); }}
                      style={{ padding: '6px 0', fontSize: '13px', color: currentView === 'deliverables' && selectedItem === d.path ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                   {d.filename}
                 </div>
               ))}
             </div>
          </div>

          <div 
            style={{...navItemStyle(currentView === 'prompts'), marginTop: '16px'}} 
            onClick={() => setCurrentView('prompts')}
          >
            <Terminal size={16} style={{ marginRight: '12px', opacity: 0.7 }} />
            System Prompts ({prompts.length})
          </div>
        </div>
      </div>
    </aside>
  );
}
