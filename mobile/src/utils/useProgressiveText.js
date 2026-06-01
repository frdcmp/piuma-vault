import { useEffect, useState } from 'react';

// Mirrors scopecreep's useProgressiveText: drips visible text toward the
// target so the assistant message types itself in even when network chunks
// arrive in bursts. Reverts instantly if the target shrinks (e.g. retry).

const getStepSize = (remaining) => {
  if (remaining > 480) return 24;
  if (remaining > 240) return 12;
  if (remaining > 120) return 6;
  if (remaining > 48) return 3;
  return 1;
};

export default function useProgressiveText(targetText, { tickMs = 18 } = {}) {
  const normalizedTarget = targetText || '';
  const [visibleText, setVisibleText] = useState(normalizedTarget);

  useEffect(() => {
    if (!normalizedTarget) {
      setVisibleText('');
      return;
    }
    setVisibleText((current) => {
      if (!current) return current;
      if (
        normalizedTarget.length < current.length ||
        !normalizedTarget.startsWith(current)
      ) {
        return normalizedTarget;
      }
      return current;
    });
  }, [normalizedTarget]);

  useEffect(() => {
    if (!normalizedTarget || visibleText === normalizedTarget) return undefined;
    const id = setTimeout(() => {
      setVisibleText((current) => {
        if (!normalizedTarget.startsWith(current)) return normalizedTarget;
        const remaining = normalizedTarget.length - current.length;
        const step = getStepSize(remaining);
        return normalizedTarget.slice(
          0,
          Math.min(normalizedTarget.length, current.length + step),
        );
      });
    }, tickMs);
    return () => clearTimeout(id);
  }, [normalizedTarget, tickMs, visibleText]);

  return {
    text: visibleText,
    isAnimating: visibleText.length < normalizedTarget.length,
  };
}
