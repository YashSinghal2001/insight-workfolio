"use client";

import { useState } from "react";
import { SCREENSHOT_MASK_MAX_REGIONS, SCREENSHOT_MASK_SCALE, type ScreenshotMaskRegion } from "@workfolio/shared";
import { inputClass, secondaryButtonClass } from "@/components/ui";

const pct = (units: number) => units / (SCREENSHOT_MASK_SCALE / 100);
const units = (percent: string) => Math.round(Number(percent) * (SCREENSHOT_MASK_SCALE / 100));
const FIELDS = [
  ["x", "Left (%)"],
  ["y", "Top (%)"],
  ["w", "Width (%)"],
  ["h", "Height (%)"],
] as const;

/**
 * Privacy masks for the screenshot form: positions in percent of the screen (stored as 1/10 000).
 * The list of inputs is the accessible source; the outline is a visual aid only. The value goes
 * into the form as hidden JSON; the API validates it (inside the screen, at most 20, labelled).
 */
export function MaskEditor({ initial }: { initial: ScreenshotMaskRegion[] }) {
  const [masks, setMasks] = useState(initial);
  const set = (i: number, patch: Partial<ScreenshotMaskRegion>) => setMasks((m) => m.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <fieldset className="flex flex-col gap-3 sm:col-span-2">
      <legend className="text-sm font-medium">Privacy masks</legend>
      <p className="text-xs text-muted">
        Areas blacked out on the employee&apos;s computer <strong>before</strong> each screenshot is saved: those pixels are never stored,
        uploaded, shown in the gallery or used in timelapses. Positions are a share of the screen, so they fit every resolution; on a
        screen with a different shape the same share covers a differently shaped area. A mask hides a fixed part of the screen, not an app:
        a window moved elsewhere is captured. Applies to new screenshots only; earlier screenshots are not changed.
      </p>
      <input type="hidden" name="maskRegions" value={JSON.stringify(masks)} />
      {masks.length === 0 && <p className="text-sm text-muted">No masks: the whole main screen is captured.</p>}
      <ol className="flex flex-col gap-3">
        {masks.map((m, i) => (
          <li key={i} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 sm:grid-cols-6" aria-label={`Mask ${i + 1}`}>
            <label className="col-span-2 flex flex-col gap-1 text-xs">
              <span>Label (shown to employees)</span>
              <input value={m.label} maxLength={60} required onChange={(e) => set(i, { label: e.target.value })} className={inputClass} />
            </label>
            {FIELDS.map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1 text-xs">
                <span>{label}</span>
                <input
                  type="number"
                  required
                  step={0.01}
                  min={k === "w" || k === "h" ? 0.01 : 0}
                  max={100}
                  value={pct(m[k])}
                  onChange={(e) => set(i, { [k]: units(e.target.value) })}
                  className={inputClass}
                />
              </label>
            ))}
            <div className="col-span-2 sm:col-span-6">
              <button type="button" className={secondaryButtonClass} onClick={() => setMasks((all) => all.filter((_, j) => j !== i))}>
                Remove mask {i + 1}
              </button>
            </div>
          </li>
        ))}
      </ol>
      {masks.length > 0 && (
        <div aria-hidden="true" className="relative aspect-video w-full max-w-sm overflow-hidden rounded border border-border bg-background">
          {masks.map((m, i) => (
            <div
              key={i}
              className="absolute bg-black/80 text-[10px] text-white"
              style={{ left: `${pct(m.x)}%`, top: `${pct(m.y)}%`, width: `${pct(m.w)}%`, height: `${pct(m.h)}%` }}
            >
              {i + 1}
            </div>
          ))}
        </div>
      )}
      <div>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={masks.length >= SCREENSHOT_MASK_MAX_REGIONS}
          onClick={() => setMasks((all) => [...all, { label: "", x: 0, y: 0, w: 2000, h: 1000 }])}
        >
          Add mask
        </button>
        <span className="ml-2 text-xs text-muted">{masks.length} of {SCREENSHOT_MASK_MAX_REGIONS}</span>
      </div>
    </fieldset>
  );
}
