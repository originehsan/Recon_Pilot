/**
 * EmptyState — icon + message + optional action button.
 * Used when a list is genuinely empty or a page has no data.
 */

import type { LucideIcon } from 'lucide-react';
import { CheckCircle2 } from 'lucide-react';

interface Props {
  icon?: LucideIcon;
  title: string;
  message?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({
  icon: Icon = CheckCircle2,
  title,
  message,
  action,
}: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-6 gap-3 text-center">
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center"
        style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
      >
        <Icon size={20} strokeWidth={1.5} />
      </div>

      <div className="flex flex-col gap-1">
        <h3
          className="text-sm font-semibold"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {title}
        </h3>
        {message && (
          <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            {message}
          </p>
        )}
      </div>

      {action && (
        <button
          onClick={action.onClick}
          className="mt-1 px-3 py-1.5 rounded text-xs font-medium transition-default"
          style={{
            background: 'var(--color-brand-dim)',
            color: 'var(--color-brand)',
            border: '1px solid var(--color-brand-border)',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(13,148,251,0.2)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-brand-dim)';
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
