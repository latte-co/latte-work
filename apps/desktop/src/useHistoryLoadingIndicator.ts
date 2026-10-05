import { useEffect, useRef, useState } from "react";

/** Delay feedback for fast history loads; keep a visible indicator from flashing. */
export function useHistoryLoadingIndicator(active: boolean, scope: string) {
  const shown = useRef<{ scope: string; at: number } | null>(null);
  const [indicator, setIndicator] = useState<{
    scope: string;
    visible: boolean;
  } | null>(null);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (active) {
      shown.current = null;
      setIndicator(null);
      timers.push(
        setTimeout(() => {
          shown.current = { scope, at: Date.now() };
          setIndicator({ scope, visible: true });
        }, 300),
      );
    } else {
      const remaining =
        shown.current?.scope === scope
          ? Math.max(0, 300 - (Date.now() - shown.current.at))
          : 0;
      const clear = () => {
        shown.current = null;
        setIndicator(null);
      };
      if (remaining > 0) timers.push(setTimeout(clear, remaining));
      else clear();
    }
    return () => timers.forEach(clearTimeout);
  }, [active, scope]);
  return {
    visible: indicator?.scope === scope && indicator.visible,
  };
}
