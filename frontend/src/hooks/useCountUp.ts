/**
 * useCountUp — animates a numeric value from its previous value to the new one.
 *
 * Uses requestAnimationFrame so the animation is tied to the display refresh
 * rate and automatically pauses in background tabs. No external dependency.
 *
 * @param target  - The target number to count up (or down) to.
 * @param duration - Animation duration in ms. Default 500ms (within the
 *                   150-600ms "calm motion" range for fintech UIs).
 *
 * Returns the current animated display value (integer).
 *
 * Respects prefers-reduced-motion: if the user has reduced-motion set, the
 * hook immediately returns the target value with no animation.
 */

import { useEffect, useRef, useState } from 'react';

/** True once, checked once per hook call — no re-render cost */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useCountUp(target: number, duration = 500): number {
  const [displayed, setDisplayed] = useState(target);
  const prevTarget = useRef(target);
  const rafRef     = useRef<number | null>(null);

  useEffect(() => {
    // Bail early: null/undefined target or reduced-motion preference
    if (prefersReducedMotion()) {
      setDisplayed(target);
      prevTarget.current = target;
      return;
    }

    const from = prevTarget.current;
    const to   = target;
    prevTarget.current = target;

    // No animation needed when the value didn't change
    if (from === to) return;

    const startTime = performance.now();

    function step(now: number) {
      const elapsed  = now - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out cubic: fast start, gentle landing — matches "calm motion" aesthetic
      const eased = 1 - Math.pow(1 - progress, 3);

      setDisplayed(Math.round(from + (to - from) * eased));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    }

    // Cancel any in-flight animation from a previous target change
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return displayed;
}
