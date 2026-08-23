/**
 * SkeletonStatCards — shimmer placeholder for the Dashboard's stat-card row.
 *
 * Renders 5 card-shaped skeleton blocks that match the real StatCard grid
 * (Total Cases | Processed | Resolved | In Review | Failed).
 *
 * Driven by the CSS `.skeleton-line` class in index.css — no JS animation.
 */

const CARD_COUNT = 5;

export function SkeletonStatCards() {
  return (
    <div
      className="grid grid-cols-5 gap-3"
      role="status"
      aria-label="Loading run stats…"
      aria-busy="true"
    >
      {Array.from({ length: CARD_COUNT }).map((_, i) => (
        <div
          key={i}
          className="card p-5 flex flex-col gap-3"
          style={{ minWidth: '140px' }}
        >
          {/* Label row — label text on left, icon on right */}
          <div className="flex items-center justify-between">
            <div className="skeleton-line h-3 rounded" style={{ width: '55%' }} />
            <div className="skeleton-line h-8 w-8 rounded-md" />
          </div>

          {/* Value — big number block */}
          <div className="skeleton-line h-8 rounded" style={{ width: '45%' }} />

          {/* Optional description line */}
          <div className="skeleton-line h-3 rounded" style={{ width: '70%' }} />
        </div>
      ))}
    </div>
  );
}
