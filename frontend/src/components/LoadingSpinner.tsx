/**
 * LoadingSpinner — centered teal spinner.
 * Used as a full-section loading state on every page.
 */

interface Props {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: 'w-5 h-5 border-2',
  md: 'w-8 h-8 border-2',
  lg: 'w-12 h-12 border-[3px]',
};

export function LoadingSpinner({ message, size = 'md' }: Props) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-16"
      role="status"
      aria-label={message ?? 'Loading…'}
    >
      <div
        className={`rounded-full animate-spin ${SIZES[size]}`}
        style={{
          borderColor: 'var(--color-border)',
          borderTopColor: 'var(--color-teal)',
        }}
      />
      {message && (
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {message}
        </p>
      )}
    </div>
  );
}
