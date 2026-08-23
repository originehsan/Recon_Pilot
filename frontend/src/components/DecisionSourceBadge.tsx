/**
 * DecisionSourceBadge — the single most judging-relevant visual element.
 *
 * Maps decidedBy values (from resolutions table) and actorType values
 * (from audit_events) to a visually distinct, unmissable pill badge.
 *
 * Color semantics (FIXED — never deviate):
 *   Teal   = Deterministic (stage1_exact | stage7_auto | SYSTEM | DECISION_GATE)
 *   Purple = AI-Assisted   (post_ai | AI)
 *   Amber  = Human         (human | HUMAN)
 *
 * This component is reused everywhere a decision source appears.
 * Never inline-duplicate this styling.
 */

import { Zap, Sparkles, User } from 'lucide-react';

type DecidedBy = 'stage1_exact' | 'stage7_auto' | 'post_ai' | 'human';
type ActorType = 'SYSTEM' | 'AI' | 'HUMAN' | 'DECISION_GATE';

interface Props {
  /** Pass either a `decidedBy` value (resolutions) or `actorType` (audit events) */
  value: DecidedBy | ActorType | string;
  /** Optional size — defaults to 'md' */
  size?: 'sm' | 'md' | 'lg';
}

type BadgeVariant = 'deterministic' | 'ai' | 'human';

function classify(value: string): BadgeVariant {
  switch (value) {
    case 'stage1_exact':
    case 'stage7_auto':
    case 'SYSTEM':
    case 'DECISION_GATE':
      return 'deterministic';
    case 'post_ai':
    case 'AI':
    case 'ai_investigation':
      return 'ai';
    case 'human':
    case 'HUMAN':
      return 'human';
    default:
      return 'deterministic'; // safe fallback
  }
}

const VARIANTS = {
  deterministic: {
    label: 'Deterministic',
    icon: Zap,
    style: {
      background: 'var(--color-teal-dim)',
      color: 'var(--color-teal)',
      border: '1px solid var(--color-teal-border)',
    },
  },
  ai: {
    label: 'AI-Assisted',
    icon: Sparkles,
    style: {
      background: 'var(--color-purple-dim)',
      color: 'var(--color-purple)',
      border: '1px solid var(--color-purple-border)',
    },
  },
  human: {
    label: 'Human',
    icon: User,
    style: {
      background: 'var(--color-amber-dim)',
      color: 'var(--color-amber)',
      border: '1px solid var(--color-amber-border)',
    },
  },
} as const;

const SIZE_CLASSES = {
  sm: { pill: 'px-2 py-0.5 text-xs gap-1', icon: 10 },
  md: { pill: 'px-2.5 py-1 text-xs gap-1.5', icon: 12 },
  lg: { pill: 'px-3 py-1.5 text-sm gap-2', icon: 14 },
};

export function DecisionSourceBadge({ value, size = 'md' }: Props) {
  const variant = classify(value);
  const { label, icon: Icon, style } = VARIANTS[variant];
  const { pill, icon: iconSize } = SIZE_CLASSES[size];

  return (
    <span
      className={`inline-flex items-center font-semibold rounded-full whitespace-nowrap ${pill}`}
      style={style}
    >
      <Icon size={iconSize} strokeWidth={2.5} />
      {label}
    </span>
  );
}
