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
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center"
        style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
      >
        <Icon size={28} strokeWidth={1.5} />
      </div>

      <div className="flex flex-col gap-1">
        <h3
          className="text-base font-semibold"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {title}
        </h3>
        {message && (
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {message}
          </p>
        )}
      </div>

      {action && (
        <button
          onClick={action.onClick}
          className="mt-2 px-4 py-2 rounded-lg text-sm font-medium transition-default"
          style={{
            background: 'var(--color-teal-dim)',
            color: 'var(--color-teal)',
            border: '1px solid var(--color-teal-border)',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(20,184,166,0.2)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-teal-dim)';
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
