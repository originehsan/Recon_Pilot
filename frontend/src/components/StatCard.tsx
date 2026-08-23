/**
 * StatCard — reusable summary stat card.
 * Used for run progress counters on the Dashboard.
 */

import type { LucideIcon } from 'lucide-react';

interface Props {
  label: string;
  value: number | string | null | undefined;
  icon?: LucideIcon;
  /** Accent color for the icon — must be one of the semantic design tokens */
  accentColor?: 'teal' | 'purple' | 'amber' | 'red' | 'gray' | 'brand' | 'success';
  /** Additional description text below the value */
  description?: string;
}

const ACCENT_COLORS: Record<NonNullable<Props['accentColor']>, string> = {
  teal:    'var(--color-teal)',
  purple:  'var(--color-purple)',
  amber:   'var(--color-amber)',
  red:     'var(--color-red)',
  gray:    'var(--color-gray)',
  brand:   'var(--color-brand)',
  success: '#04db7c',
};

export function StatCard({ label, value, icon: Icon, accentColor = 'gray', description }: Props) {
  const accent = ACCENT_COLORS[accentColor];

  return (
    <div
      className="card p-5 flex flex-col gap-3"
      style={{ minWidth: '140px' }}
    >
      <div className="flex items-center justify-between">
        <span
          className="section-label"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {label}
        </span>
        {Icon && (
          <span
            className="flex items-center justify-center w-8 h-8 rounded-md"
            style={{
              background: `${accent}1A`,
              color: accent,
            }}
          >
            <Icon size={16} strokeWidth={2} />
          </span>
        )}
      </div>

      <div>
        <span
          className="text-3xl font-bold tracking-tight"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {value ?? '—'}
        </span>
        {description && (
          <p
            className="text-xs mt-1"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
