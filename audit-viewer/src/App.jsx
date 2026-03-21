import React, { useState } from 'react';
import { useData } from './lib/dataStore';
import UploadScreen from './components/UploadScreen';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import DeliverablesView from './components/DeliverablesView';
import WorkflowTimeline from './components/WorkflowTimeline';
import AgentView from './components/AgentView';

import PromptsView from './components/PromptsView';

export default function App() {
  const { isLoaded } = useData();
  const [currentView, setCurrentView] = useState('dashboard');
  const [selectedItem, setSelectedItem] = useState(null); // ID of agent, deliverable, etc.

  if (!isLoaded) {
    return <UploadScreen />;
  }

  const renderContent = () => {
    switch (currentView) {
      case 'dashboard':
        return <Dashboard />;
      case 'workflow':
        return <WorkflowTimeline onSelectAgent={id => { setCurrentView('agent'); setSelectedItem(id); }} />;
      case 'deliverables':
        return <DeliverablesView deliverablePath={selectedItem} />;
      case 'agent':
        return <AgentView agentId={selectedItem} />;
      case 'prompts':
        return <PromptsView />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <Sidebar 
        currentView={currentView} 
        setCurrentView={setCurrentView} 
        selectedItem={selectedItem} 
        setSelectedItem={setSelectedItem} 
      />
      <main style={{ 
        flex: 1, 
        overflowY: 'auto', 
        padding: '24px',
        backgroundColor: 'var(--bg-base)'
      }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
          {renderContent()}
        </div>
      </main>
    </div>
  );
}
