import { TagIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { useSidebarTagsStore } from "../sidebarTagsStore";

/** A tag icon that pops once when `#` in the composer changes the tags of `target`. */
export function TagPulseIcon({ target, className }: { target: string; className?: string }) {
  const seq = useSidebarTagsStore((store) =>
    store.pulse?.target === target ? store.pulse.seq : 0,
  );
  return (
    <TagIcon
      // A new key restarts the animation when the same thread is tagged twice in a row.
      key={seq}
      aria-hidden="true"
      className={cn(className, seq > 0 && "motion-safe:animate-tag-pop")}
      onAnimationEnd={() => useSidebarTagsStore.getState().settlePulse(seq)}
    />
  );
}
