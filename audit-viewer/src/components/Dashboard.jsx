import React from 'react';
import { useData } from '../lib/dataStore';
import { Bot, Clock, DollarSign, Target, AlertTriangle } from 'lucide-react';

const MetricCard = ({ title, value, icon, color }) => (
  <div className="glass-panel" style={{ padding: '24px', flex: 1 }}>
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
      <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: `${color}15`, color: color, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '16px' }}>
        {icon}
      </div>
      <h3 style={{ color: 'var(--text-secondary)', fontSize: '14px', margin: 0 }}>{title}</h3>
    </div>
    <div style={{ fontSize: '32px', fontWeight: 700, letterSpacing: '-1px' }}>{value}</div>
  </div>
);

export default function Dashboard() {
  const { sessionData, metrics } = useData();

  if (!metrics) return null;

  const durationStr = metrics.totalDurationMs > 0 
    ? new Date(metrics.totalDurationMs).toISOString().substr(11, 8) 
    : '00:00:00';

  const isSuccess = sessionData?.session?.status === 'completed' || sessionData?.session?.status === 'success';

  return (
    <div className="animate-fade-in" style={{ paddingBottom: '48px' }}>
      <header style={{ marginBottom: '40px' }}>
        <h1 style={{ fontSize: '32px', marginBottom: '8px' }}>Session Overview</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          {sessionData?.session?.id || 'Unknown Session'} • Started {sessionData?.session?.createdAt ? new Date(sessionData.session.createdAt).toLocaleString() : 'Unknown Time'}
        </p>
      </header>

      <div style={{ display: 'flex', gap: '24px', marginBottom: '40px', flexWrap: 'wrap' }}>
        <MetricCard 
          title="Total Agents" 
          value={`${metrics.successCount} / ${metrics.totalAgents}`}
          icon={<Bot size={20} />}
          color="var(--accent-primary)"
        />
        <MetricCard 
          title="Total Cost" 
          value={`$${metrics.totalCost.toFixed(4)}`}
          icon={<DollarSign size={20} />}
          color="var(--color-low)"
        />
        <MetricCard 
          title="Wall Duration" 
          value={durationStr}
          icon={<Clock size={20} />}
          color="var(--accent-secondary)"
        />
        <MetricCard 
          title="Overall Status" 
          value={sessionData?.session?.status || 'Unknown'}
          icon={isSuccess ? <Target size={20} /> : <AlertTriangle size={20} />}
          color={isSuccess ? 'var(--color-success)' : 'var(--color-warning)'}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '24px' }}>Phase Cost Breakdown</h2>
          {sessionData?.metrics?.phases && Object.entries(sessionData.metrics.phases).map(([phase, data]) => {
            const cost = data.cost_usd || data.total_cost_usd || 0;
            if (cost === 0) return null;
            const pct = (cost / metrics.totalCost) * 100;
            return (
              <div key={phase} style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '14px' }}>
                  <span style={{ textTransform: 'capitalize' }}>{phase.replace(/-/g, ' ')}</span>
                  <span>${cost.toFixed(4)}</span>
                </div>
                <div style={{ width: '100%', height: '8px', background: 'var(--bg-surface-active)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: 'var(--accent-primary)', borderRadius: '4px' }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '24px' }}>Phase Duration Breakdown</h2>
          {sessionData?.metrics?.phases && Object.entries(sessionData.metrics.phases).map(([phase, data]) => {
            const durMs = data.duration_ms || data.total_duration_ms || 0;
            if (durMs === 0) return null;
            const pct = (durMs / metrics.totalDurationMs) * 100;
            return (
              <div key={phase} style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '14px' }}>
                  <span style={{ textTransform: 'capitalize' }}>{phase.replace(/-/g, ' ')}</span>
                  <span>{(durMs / 1000).toFixed(1)}s</span>
                </div>
                <div style={{ width: '100%', height: '8px', background: 'var(--bg-surface-active)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: 'var(--accent-secondary)', borderRadius: '4px' }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
