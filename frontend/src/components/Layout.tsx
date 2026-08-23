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
      {/* The bar's background/border still span the full viewport width;
          only the CONTENT inside is constrained to max-w-7xl, matching
          <main>'s content column below - so the wordmark's left edge and
          the nav links' right edge line up with the page content's edges
          instead of sitting at the raw viewport edges with a large empty
          gap between them on wide screens. */}
      <header
        className="sticky top-0 z-50 h-14"
        style={{
          background: 'var(--color-bg-surface)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <div className="max-w-7xl mx-auto h-14 flex items-center justify-between px-8">
          {/* Wordmark */}
          <div className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center"
              style={{ background: 'var(--color-brand-dim)', color: 'var(--color-brand)' }}
            >
              <Activity size={16} strokeWidth={2.5} />
            </div>
            <span
              className="text-base font-bold tracking-tight"
              style={{ color: 'var(--color-text-primary)' }}
            >
              ReconPilot
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
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-default"
                    style={{
                      background: isActive ? 'var(--color-brand-dim)' : 'transparent',
                      color: isActive ? 'var(--color-brand)' : 'var(--color-text-secondary)',
                      border: isActive ? '1px solid var(--color-brand-border)' : '1px solid transparent',
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
        </div>
      </header>

      {/* ── Page Content ────────────────────────────────────────── */}
      <main className="flex-1">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <Outlet />
        </div>
      </main>

      {/* ── Footer ──────────────────────────────────────────────── */}
      {/* Same max-w-7xl content constraint as the header/main, so the
          footer text's left edge lines up with the wordmark and page
          content above it instead of sitting flush at the viewport edge. */}
      <footer
        className="py-3 text-xs"
        style={{
          borderTop: '1px solid var(--color-border)',
          color: 'var(--color-text-muted)',
        }}
      >
        <div className="max-w-7xl mx-auto px-8">
          ReconPilot · Razorpay AI Buildathon 2026 · AI Finance Controller Track
        </div>
      </footer>
    </div>
  );
}
