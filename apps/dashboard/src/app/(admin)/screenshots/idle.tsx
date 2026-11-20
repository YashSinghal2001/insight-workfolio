import { StatusBadge } from "@/components/kit";

/** Card frame: a red border marks a screenshot captured while the employee was idle (the "Idle" badge says it in text). */
export const shotFrameClass = (idle: boolean) => `overflow-hidden rounded-lg bg-surface ${idle ? "border-2 border-danger" : "border border-border"}`;

/** Text label for idle captures, so colour is never the only signal. */
export function IdleBadge({ idle }: { idle: boolean }) {
  if (!idle) return null;
  return (
    <span title="Captured while the employee was idle: no keyboard or mouse input for the idle threshold">
      <StatusBadge tone="danger">Idle</StatusBadge>
    </span>
  );
}
