/**
 * Layout — persistent top navigation bar + content area.
 *
 * Top bar: dark surface, bottom border, app wordmark on left, nav links on right.
 * Content: max-w-7xl centered with consistent vertical padding.
 */

import { NavLink, Outlet } from 'react-router-dom';
import { Activity, LayoutDashboard, AlertTriangle, Search } from 'lucide-react';

const NAV_LINKS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/exceptions', label: 'Exceptions', icon: AlertTriangle, end: false },
  { to: '/audit', label: 'Audit Lookup', icon: Search, end: false },
] as const;

export function Layout() {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--color-bg-base)' }}
    >
      {/* ── Top Bar ─────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-8 h-14"
        style={{
          background: 'var(--color-bg-surface)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        {/* Wordmark */}
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-md flex items-center justify-center"
            style={{ background: 'var(--color-teal-dim)', color: 'var(--color-teal)' }}
          >
            <Activity size={16} strokeWidth={2.5} />
          </div>
          <span
            className="text-base font-bold tracking-tight"
            style={{ color: 'var(--color-text-primary)' }}
          >
            ReconPilot
          </span>
          <span
            className="text-xs font-medium px-1.5 py-0.5 rounded"
            style={{
              background: 'var(--color-teal-dim)',
              color: 'var(--color-teal)',
              border: '1px solid var(--color-teal-border)',
            }}
          >
            BETA
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex items-center gap-1">
          {NAV_LINKS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className="group"
              style={{ textDecoration: 'none' }}
            >
              {({ isActive }) => (
                <span
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-default"
                  style={{
                    background: isActive ? 'var(--color-teal-dim)' : 'transparent',
                    color: isActive ? 'var(--color-teal)' : 'var(--color-text-secondary)',
                    border: isActive ? '1px solid var(--color-teal-border)' : '1px solid transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLSpanElement).style.background = 'var(--color-bg-elevated)';
                      (e.currentTarget as HTMLSpanElement).style.color = 'var(--color-text-primary)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLSpanElement).style.background = 'transparent';
                      (e.currentTarget as HTMLSpanElement).style.color = 'var(--color-text-secondary)';
                    }
                  }}
                >
                  <Icon size={14} strokeWidth={2} />
                  {label}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </header>

      {/* ── Page Content ────────────────────────────────────────── */}
      <main className="flex-1">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <Outlet />
        </div>
      </main>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer
        className="px-8 py-3 text-xs"
        style={{
          borderTop: '1px solid var(--color-border)',
          color: 'var(--color-text-muted)',
        }}
      >
        ReconPilot · Razorpay AI Buildathon 2026 · AI Finance Controller Track
      </footer>
    </div>
  );
}
