import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { RunProvider } from './context/RunContext.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Exceptions } from './pages/Exceptions.tsx';
import { AuditLookup } from './pages/AuditLookup.tsx';

export default function App() {
  return (
    <BrowserRouter>
      <RunProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/exceptions" element={<Exceptions />} />
            <Route path="/audit" element={<AuditLookup />} />
          </Route>
        </Routes>
      </RunProvider>
    </BrowserRouter>
  );
}
