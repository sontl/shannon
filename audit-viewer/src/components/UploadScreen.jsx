import React, { useCallback, useState } from 'react';
import { UploadCloud, FolderUp, CheckCircle, AlertCircle, FileCode } from 'lucide-react';
import { loadDirectory } from '../lib/directoryLoader';
import { useData } from '../lib/dataStore';

export default function UploadScreen() {
  const { loadData, loadingError } = useData();
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleFiles = async (files) => {
    setIsLoading(true);
    try {
      const filesMap = await loadDirectory(files);
      await loadData(filesMap);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    
    // Check if what was dropped is a directory (simplified checking)
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const item = items[0].webkitGetAsEntry();
      if (item && item.isDirectory) {
        // We still need the actual files, and DataTransferItem.webkitGetAsEntry()
        // directory traversal is complex. Fallback to input element is easier for users.
        // For actual drag-and-drop file trees we'd need a recursive reader.
      }
    }
    
    // For now, if they drop files, we try to use them
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, []);

  const handleFileInput = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  };

  const handleSampleData = async () => {
    setIsLoading(true);
    try {
      // Load files statically via Vite's import.meta.glob
      const sampleFiles = import.meta.glob('../sample-data/**/*', { query: '?raw', import: 'default', eager: true });
      const filesMap = {};
      for (const [path, content] of Object.entries(sampleFiles)) {
        // Strip out the '../sample-data/' prefix but keep leading slash for parser matching
        const strippedPath = '/' + path.replace('../sample-data/', '');
        filesMap[strippedPath] = content;
      }
      await loadData(filesMap);
    } catch (e) {
      console.error('Failed to load sample data:', e);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex-center" style={{ minHeight: '100vh', padding: '24px' }}>
      <div 
        className={`glass-panel upload-zone animate-fade-in ${isDragging ? 'active' : ''}`}
        style={{
          maxWidth: '600px',
          width: '100%',
          padding: '48px',
          textAlign: 'center',
          borderColor: isDragging ? 'var(--color-accent)' : 'var(--border-light)',
          background: isDragging ? 'rgba(56, 189, 248, 0.05)' : 'var(--bg-glass)'
        }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <div style={{ 
          width: '80px', height: '80px', borderRadius: '50%', 
          background: 'rgba(56,189,248,0.1)', color: 'var(--color-accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 24px auto'
        }}>
          {isLoading ? <span className="animate-spin"><UploadCloud size={40} /></span> : <FolderUp size={40} />}
        </div>
        
        <h1 style={{ fontSize: '28px', marginBottom: '8px' }}>Shannon Audit Viewer</h1>
        <div style={{ fontSize: '14px', color: 'var(--text-tertiary)', marginBottom: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          By <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>Techvify</span>
        </div>
        
        <p style={{ color: 'var(--text-secondary)', marginBottom: '32px', fontSize: '16px', lineHeight: 1.5 }}>
          Upload an `audit-logs` directory to visualize the pentest execution, view findings, and read the generated reports.
        </p>

        {loadingError && (
          <div style={{ 
            background: 'rgba(239,68,68,0.1)', color: 'var(--color-error)', 
            padding: '12px 16px', borderRadius: '8px', marginBottom: '24px',
            display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center'
          }}>
            <AlertCircle size={18} />
            <span>{loadingError}</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center' }}>
          <label 
            htmlFor="directory-upload" 
            style={{
              background: 'var(--color-accent)', color: '#0f172a',
              padding: '12px 24px', borderRadius: '8px', cursor: 'pointer',
              fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '8px',
              transition: 'all 0.2s', opacity: isLoading ? 0.7 : 1,
              pointerEvents: isLoading ? 'none' : 'auto'
            }}
          >
            <FolderUp size={20} />
            {isLoading ? 'Processing Files...' : 'Select Audit Logs Directory'}
          </label>
          <input 
            type="file" 
            id="directory-upload" 
            webkitdirectory="true" 
            directory="true" 
            multiple 
            onChange={handleFileInput}
            style={{ display: 'none' }}
          />
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', width: '100%', margin: '8px 0' }}>
            <div style={{ flex: 1, height: '1px', background: 'var(--border-light)' }}></div>
            <span style={{ color: 'var(--text-tertiary)', fontSize: '14px' }}>OR</span>
            <div style={{ flex: 1, height: '1px', background: 'var(--border-light)' }}></div>
          </div>
          
          <button 
            onClick={handleSampleData}
            disabled={isLoading}
            style={{
              background: 'transparent', color: 'var(--text-primary)',
              border: '1px solid var(--border-light)',
              padding: '12px 24px', borderRadius: '8px', cursor: 'pointer',
              fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '8px',
              transition: 'all 0.2s', opacity: isLoading ? 0.7 : 1,
            }}
            onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--text-secondary)'; e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
            onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border-light)'; e.currentTarget.style.background = 'transparent'; }}
          >
            <FileCode size={20} />
            Load Sample Data
          </button>
        </div>
        
        <div style={{ marginTop: '48px', display: 'flex', justifyContent: 'center', gap: '24px', color: 'var(--text-tertiary)', fontSize: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><CheckCircle size={16} color="var(--color-success)" /> Local Processing</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><CheckCircle size={16} color="var(--color-success)" /> No Server Needed</div>
        </div>
      </div>
    </div>
  );
}
