/**
 * SkeletonTable — shimmer placeholder for the Exceptions table while data loads.
 *
 * Renders 5 table-row-shaped skeleton bars that match the real table's column
 * layout (Reason | Exposure | Narration | Priority | Action).
 *
 * The shimmer sweep is driven purely by the CSS `.skeleton-line` class in
 * index.css — no JavaScript animation, no library.
 */

/** Number of placeholder rows to show */
const ROW_COUNT = 5;

/**
 * Column widths expressed as Tailwind/inline classes so the skeleton
 * visually mirrors the real table's proportions.
 */
const COLS: Array<{ width: string; align: 'left' | 'right' }> = [
  { width: '55%',  align: 'left'  }, // Reason + badge
  { width: '12%',  align: 'right' }, // Exposure
  { width: '18%',  align: 'left'  }, // Narration
  { width: '8%',   align: 'right' }, // Priority Score
  { width: '7%',   align: 'right' }, // Action button
];

export function SkeletonTable() {
  return (
    <div
      className="card overflow-hidden"
      role="status"
      aria-label="Loading exceptions…"
      aria-busy="true"
    >
      {/* Header bar */}
      <div
        className="flex items-center gap-6 px-5 py-3"
        style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-elevated)' }}
      >
        {/* Badge placeholder */}
        <div className="skeleton-line h-4 rounded-full" style={{ width: 120 }} />
        <div className="skeleton-line h-4 rounded-full" style={{ width: 160 }} />
      </div>

      {/* Fake thead */}
      <div
        className="flex items-center px-5 py-3 gap-2"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        {COLS.map((col, i) => (
          <div
            key={i}
            style={{ width: col.width, display: 'flex', justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start' }}
          >
            <div className="skeleton-line h-3 rounded" style={{ width: '60%' }} />
          </div>
        ))}
      </div>

      {/* Fake rows */}
      {Array.from({ length: ROW_COUNT }).map((_, rowIdx) => (
        <div
          key={rowIdx}
          className="flex items-center px-5 gap-2"
          style={{
            paddingTop: '14px',
            paddingBottom: '14px',
            borderBottom: rowIdx < ROW_COUNT - 1 ? '1px solid var(--color-border-subtle)' : 'none',
          }}
        >
          {/* Reason cell — badge + label side by side */}
          <div style={{ width: COLS[0].width, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="skeleton-line h-5 rounded-full" style={{ width: 80, flexShrink: 0 }} />
            <div className="skeleton-line h-4 rounded" style={{ width: '55%' }} />
          </div>

          {/* Exposure — right-aligned narrow */}
          <div style={{ width: COLS[1].width, display: 'flex', justifyContent: 'flex-end' }}>
            <div className="skeleton-line h-4 rounded" style={{ width: '70%' }} />
          </div>

          {/* Narration */}
          <div style={{ width: COLS[2].width }}>
            <div className="skeleton-line h-4 rounded" style={{ width: '80%' }} />
          </div>

          {/* Priority Score */}
          <div style={{ width: COLS[3].width, display: 'flex', justifyContent: 'flex-end' }}>
            <div className="skeleton-line h-4 rounded" style={{ width: '90%' }} />
          </div>

          {/* Action button placeholder */}
          <div style={{ width: COLS[4].width, display: 'flex', justifyContent: 'flex-end' }}>
            <div className="skeleton-line h-6 rounded-md" style={{ width: '100%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
