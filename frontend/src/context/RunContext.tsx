/**
 * RunContext — shares the current runId across the app.
 *
 * Using React Context instead of localStorage/sessionStorage (per spec).
 * Dashboard sets the runId after starting a run; Exceptions reads it.
 */

import { createContext, useContext, useState, type ReactNode } from 'react';

interface RunContextValue {
  runId: number | null;
  setRunId: (id: number | null) => void;
}

const RunContext = createContext<RunContextValue | null>(null);

export function RunProvider({ children }: { children: ReactNode }) {
  const [runId, setRunId] = useState<number | null>(null);

  return (
    <RunContext.Provider value={{ runId, setRunId }}>
      {children}
    </RunContext.Provider>
  );
}

export function useRunContext(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) {
    throw new Error('useRunContext must be used within RunProvider');
  }
  return ctx;
}
