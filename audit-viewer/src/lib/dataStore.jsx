import React, { createContext, useContext, useState, useMemo } from 'react';
import { parseSessionJson, parseWorkflowLog, parseAgentLog, parseDeliverable, parsePrompt } from './parsers';

const DataContext = createContext(null);

export const useData = () => {
  const context = useContext(DataContext);
  if (!context) throw new Error('useData must be used within DataProvider');
  return context;
};

export function DataProvider({ children }) {
  const [sessionData, setSessionData] = useState(null);
  const [workflowEvents, setWorkflowEvents] = useState([]);
  const [agents, setAgents] = useState({});
  const [deliverables, setDeliverables] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadingError, setLoadingError] = useState(null);

  const loadData = async (filesMap) => {
    try {
      let session = null;
      const wfEvents = [];
      const agts = {};
      const delivs = [];
      const prmps = [];

      for (const [path, content] of Object.entries(filesMap)) {
        if (path.endsWith('session.json')) {
          session = parseSessionJson(content);
        } else if (path.endsWith('workflow.log')) {
          const events = parseWorkflowLog(content);
          wfEvents.push(...events);
        } else if (path.includes('/agents/') && path.endsWith('.log')) {
          const agentId = path.split('/').pop().replace('.log', '');
          agts[agentId] = { id: agentId, ...parseAgentLog(content) };
        } else if (path.includes('/deliverables/')) {
          const filename = path.split('/').pop();
          delivs.push({ filename, path, ...parseDeliverable(filename, content) });
        } else if (path.includes('/prompts/')) {
          const filename = path.split('/').pop();
          prmps.push({ filename, path, ...parsePrompt(filename, content) });
        }
      }

      let currentPhase = 'unknown';
      for (const e of wfEvents) {
        if (e.level === 'PHASE' && e.message.startsWith('Starting:')) {
          currentPhase = e.message.split('Starting:')[1].trim();
        } else if (e.level === 'AGENT' && e.message.includes(': Starting')) {
          const agentName = e.message.split(': Starting')[0].trim();
          const agtsArr = Object.values(agts);
          // Agent names in log header are like 'xss-vuln'. We update all loaded agent logs hitting that agent.
          const agt = agtsArr.find(a => a.header?.agent === agentName);
          if (agt) {
            agt.header.phase = currentPhase;
          }
        }
      }

      setSessionData(session);
      setWorkflowEvents(wfEvents);
      setAgents(agts);
      setDeliverables(delivs);
      setPrompts(prmps);
      setIsLoaded(true);
      setLoadingError(null);
    } catch (e) {
      console.error(e);
      setLoadingError(e.message);
    }
  };
  
  const reset = () => {
    setSessionData(null);
    setWorkflowEvents([]);
    setAgents({});
    setDeliverables([]);
    setPrompts([]);
    setIsLoaded(false);
    setLoadingError(null);
  }

  // Derived metrics
  const metrics = useMemo(() => {
    if (!sessionData) return null;
    let totalAgents = Object.keys(agents).length;
    let successCount = Object.values(agents).filter(a => a.success).length;
    let totalCost = sessionData.metrics?.total_cost_usd || 0;
    let totalDurationMs = sessionData.metrics?.total_duration_ms || 0;

    return {
      totalAgents,
      successCount,
      successRate: totalAgents > 0 ? (successCount / totalAgents) * 100 : 0,
      totalCost,
      totalDurationMs
    };
  }, [sessionData, agents]);

  return (
    <DataContext.Provider value={{ 
      sessionData, workflowEvents, agents, deliverables, prompts, 
      isLoaded, loadingError, loadData, reset, metrics 
    }}>
      {children}
    </DataContext.Provider>
  );
}
