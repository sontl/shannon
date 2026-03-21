import React from 'react';
import { useData } from '../lib/dataStore';

export default function PromptsView() {
  const { prompts } = useData();

  return (
    <div className="animate-fade-in" style={{ paddingBottom: '48px' }}>
      <header style={{ marginBottom: '40px' }}>
        <h1 style={{ fontSize: '32px', marginBottom: '8px' }}>System Prompts</h1>
        <p style={{ color: 'var(--text-secondary)' }}>Templates and instructions provided to AI agents</p>
      </header>

      {prompts.map((prompt, index) => (
        <div key={index} className="glass-panel" style={{ marginBottom: '24px' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-light)', background: 'var(--bg-surface-hover)' }}>
            <h3 style={{ fontSize: '16px', margin: 0 }}>{prompt.filename}</h3>
          </div>
          <div style={{ padding: '24px', overflowX: 'auto' }}>
            <pre style={{ margin: 0, color: 'var(--text-primary)', fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>
              {prompt.data}
            </pre>
          </div>
        </div>
      ))}
      
      {prompts.length === 0 && (
        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          No prompts found in the audit logs.
        </div>
      )}
    </div>
  );
}
