/**
 * Sparkline — uPlot-backed streaming line chart.
 *
 * Lifecycle:
 *   - `onMount`     — instantiate uPlot once with the initial data + period
 *   - `createEffect` — re-call `setData` on data change. If `samplePeriodMs`
 *                     changes (rare), destroy + recreate so uPlot's internal
 *                     X-scale reflects the new sample timing.
 *   - `makeResizeObserver` (`@solid-primitives/resize-observer`) reflows the
 *     chart when its parent (typically a Corvu Resizable panel) resizes —
 *     uPlot has no built-in resize handling and a fixed-mount width would
 *     otherwise stretch / clip on drag.
 *   - `onCleanup`   — destroy the uPlot instance when the component unmounts;
 *     `makeResizeObserver` cleans up its `ResizeObserver` automatically.
 *
 * X axis is synthesized from sample index × `samplePeriodMs`. The X array is
 * cached per instance and grown / shrunk in place — for an append-only sliding
 * window at 1 Hz, the natural-state-once-filled refresh pattern is "same
 * length, same period" which becomes a no-op array reuse.
 *
 * `colorVar` is a CSS variable name (default `--primary`) — accent stroke +
 * 18%-opacity fill. The `color-mix(in oklch, ...)` syntax matches our
 * `styles.css` token palette (oklch throughout).
 */
import { onMount, onCleanup, createEffect, type Component } from "solid-js";
import { makeResizeObserver } from "@solid-primitives/resize-observer";
import uPlot from "uplot";
import { cn } from "../../lib/cn";
import type { SparklineProps } from "../../primitives";

// uPlot's stylesheet is `@import`-ed once from `dashboard/styles.css` so
// every host that loads the dashboard's CSS bundle picks up the chart's
// `.uplot`-prefixed selectors.

export const Sparkline: Component<SparklineProps> = (props) => {
  // `containerRef!` uses definite-assignment — the `ref={containerRef}` binding
  // fires before `onMount`. `plot` stays `| undefined` because construction
  // is conditional on container presence.
  let containerRef!: HTMLDivElement;
  let plot: uPlot | undefined;

  // Per-instance reusable X-axis state. Keeps the array reference stable
  // across `setData` calls once the sliding window has filled.
  let xs: number[] = [];
  let xsPeriod = 0;
  let lastPeriod = 0;

  const samplePeriodMs = (): number => props.samplePeriodMs ?? 1000;
  const height = (): number => props.height ?? 64;
  const colorVar = (): string => props.colorVar ?? "--primary";

  // Returns a defensive copy: uPlot's `setData` stores the array reference
  // (no internal copy), so mutating `xs` in place between paints would corrupt
  // its X scale on the next render. The copy is O(n) memcpy — still cheaper
  // than the prior `Array.from({ length }, mapper)` because the values are
  // already computed and reused across calls (only the slice is per-call).
  const ensureXs = (count: number, periodMs: number): number[] => {
    if (xsPeriod !== periodMs) {
      xs = [];
      xsPeriod = periodMs;
    }
    while (xs.length < count) xs.push((xs.length * periodMs) / 1000);
    if (xs.length > count) xs.length = count;
    return xs.slice();
  };

  const buildOpts = (): uPlot.Options => {
    const accent = colorVar();
    return {
      width: containerRef.clientWidth || 100,
      height: height(),
      pxAlign: false,
      cursor: { show: false },
      legend: { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      scales: { x: { time: false }, y: { auto: true } },
      axes: [{ show: false }, { show: false }],
      series: [
        {},
        {
          stroke: `var(${accent})`,
          width: 1.5,
          fill: `color-mix(in oklch, var(${accent}) 18%, transparent)`,
        },
      ],
    };
  };

  // The `[...]` copy on the Y array is load-bearing — uPlot's `AlignedData`
  // type requires `number[]`, not `readonly number[]`, and a straight cast
  // fails on the readonly→mutable widening. The X array is cached across
  // calls (mutable in place) so this allocation is the only per-tick cost.
  const createPlot = (initialData: readonly number[], period: number): uPlot =>
    new uPlot(
      buildOpts(),
      [ensureXs(initialData.length, period), [...initialData]] as uPlot.AlignedData,
      containerRef,
    );

  // Reflow the chart on container resize. `makeResizeObserver` returns
  // `{ observe, unobserve }`; the inner observer is disposed automatically
  // on scope cleanup (the Solid primitive's `onCleanup`-coupled lifecycle).
  // Skipping when there's no plot avoids a stray `setSize` during initial
  // mount, before `onMount` has constructed the instance.
  const { observe } = makeResizeObserver((entries) => {
    if (!plot) return;
    const entry = entries[0];
    if (!entry) return;
    plot.setSize({ width: entry.contentRect.width, height: height() });
  });

  onMount(() => {
    if (!containerRef) return;
    const period = samplePeriodMs();
    plot = createPlot(props.data, period);
    lastPeriod = period;
    observe(containerRef);
  });

  onCleanup(() => {
    plot?.destroy();
    plot = undefined;
  });

  createEffect(() => {
    const data = props.data;
    const period = samplePeriodMs();
    if (!plot) return;

    if (period !== lastPeriod) {
      // Period changed — destroy + recreate so uPlot's X scale reflects
      // the new sample timing. Rare in practice (period is usually a
      // static prop), but caught here for correctness.
      plot.destroy();
      plot = createPlot(data, period);
      lastPeriod = period;
      return;
    }

    plot.setData([ensureXs(data.length, period), [...data]] as uPlot.AlignedData);
  });

  return (
    <div ref={containerRef} class={cn("w-full", props.class)} style={{ height: `${height()}px` }} />
  );
};
