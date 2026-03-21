import React, { useEffect, useState, useRef } from 'react';
import { useData } from '../lib/dataStore';
import { marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';

// Configure marked to use highlight.js
marked.setOptions({
  highlight: function (code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language }).value;
  },
  breaks: true,
  gfm: true
});

export default function DeliverablesView({ deliverablePath }) {
  const { deliverables } = useData();
  const deliverable = deliverables.find(d => d.path === deliverablePath);
  const containerRef = useRef(null);

  if (!deliverable) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
        Select a deliverable from the sidebar to view it.
      </div>
    );
  }

  return (
    <div className="animate-fade-in" style={{ paddingBottom: '48px' }}>
      <header style={{ marginBottom: '32px', borderBottom: '1px solid var(--border-light)', paddingBottom: '24px' }}>
        <h1 style={{ fontSize: '28px', marginBottom: '8px' }}>{deliverable.filename}</h1>
        <p style={{ color: 'var(--text-secondary)', display: 'flex', gap: '16px' }}>
          <span style={{ 
            background: deliverable.type === 'json' ? 'rgba(0,229,255,0.1)' : 'rgba(138,43,226,0.1)',
            color: deliverable.type === 'json' ? 'var(--accent-primary)' : 'var(--accent-secondary)',
            padding: '4px 12px', borderRadius: 'var(--radius-pill)', fontSize: '12px', fontWeight: 600
          }}>
            {deliverable.type.toUpperCase()}
          </span>
          <span style={{ opacity: 0.6 }}>{deliverable.path}</span>
        </p>
      </header>

      {deliverable.type === 'json' ? (
        <div className="glass-panel" style={{ padding: '24px', overflowX: 'auto' }}>
          <pre style={{ margin: 0, color: 'var(--text-primary)', fontSize: '13px', lineHeight: 1.6 }}>
             {JSON.stringify(deliverable.data, null, 2)}
          </pre>
        </div>
      ) : (
        <div 
          ref={containerRef}
          className="markdown-body" 
          style={{ 
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: '15px',
            lineHeight: 1.6,
            maxWidth: '900px'
          }}
          dangerouslySetInnerHTML={{ __html: marked.parse(deliverable.data || '') }} 
        />
      )}
      
      <style dangerouslySetInnerHTML={{__html: `
        .markdown-body h1, .markdown-body h2, .markdown-body h3 {
          border-bottom: 1px solid var(--border-light);
          padding-bottom: 0.3em;
          margin-top: 1.5em;
          margin-bottom: 16px;
        }
        .markdown-body a { color: var(--accent-primary); }
        .markdown-body p, .markdown-body ul, .markdown-body ol { margin-bottom: 16px; }
        .markdown-body li { margin-bottom: 4px; }
        .markdown-body code {
          background: var(--bg-surface);
          padding: 0.2em 0.4em;
          border-radius: 3px;
          font-family: var(--font-mono);
          font-size: 85%;
        }
        .markdown-body pre {
          background: #282c34; /* atom-one-dark bg */
          padding: 16px;
          border-radius: var(--radius-md);
          overflow: auto;
          margin-bottom: 16px;
        }
        .markdown-body pre code {
          background: transparent;
          padding: 0;
        }
        .markdown-body table {
          border-spacing: 0; border-collapse: collapse; width: 100%; margin-bottom: 16px;
        }
        .markdown-body th, .markdown-body td {
          border: 1px solid var(--border-light); padding: 6px 13px;
        }
        .markdown-body th { background: var(--bg-surface-hover); }
        .markdown-body blockquote {
          margin: 0 0 16px 0; padding: 0 1em; color: var(--text-secondary);
          border-left: 0.25em solid var(--border-light);
        }
      `}} />
    </div>
  );
}
