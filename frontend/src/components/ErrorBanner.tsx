/**
 * ErrorBanner — dismissible red-accented error message.
 * Used on every page when an API call fails.
 * Never silently swallow errors — always render this.
 */

import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface Props {
  message: string;
  /** Optional additional detail (e.g. Zod validation issues) */
  detail?: string;
  onDismiss?: () => void;
}

export function ErrorBanner({ message, detail, onDismiss }: Props) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    onDismiss?.();
  }

  return (
    <div
      role="alert"
      className="flex items-start gap-3 p-4 rounded-lg"
      style={{
        background: 'var(--color-red-dim)',
        border: '1px solid var(--color-red-border)',
      }}
    >
      <AlertTriangle
        size={18}
        className="mt-0.5 shrink-0"
        style={{ color: 'var(--color-red)' }}
      />

      <div className="flex-1 min-w-0">
        <p
          className="text-sm font-medium"
          style={{ color: 'var(--color-red)' }}
        >
          {message}
        </p>
        {detail && (
          <p
            className="text-xs mt-1"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {detail}
          </p>
        )}
      </div>

      <button
        onClick={handleDismiss}
        aria-label="Dismiss error"
        className="shrink-0 p-1 rounded transition-default"
        style={{ color: 'var(--color-text-muted)' }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-red)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)';
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
