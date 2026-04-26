/**
 * Sparkline — uPlot-backed streaming line chart.
 *
 * Lifecycle:
 *   - `onMount`     — instantiate uPlot once with the initial data
 *   - `createEffect` — re-call `setData` whenever the reactive `data`
 *                     changes (this is uPlot's idiomatic streaming
 *                     update path; full re-instantiation would flicker)
 *   - `onCleanup`   — destroy the uPlot instance when the component
 *                     unmounts so we don't leak the inner canvas + RO
 *
 * X axis is synthesized from sample index × `samplePeriodMs`; the chart
 * is purely decorative so a real time axis isn't needed.
 *
 * `colorVar` is a CSS variable name (default `--primary`) — accent
 * stroke + 18%-opacity fill. The `color-mix(in oklch, ...)` syntax
 * matches our `styles.css` token palette (oklch throughout).
 */
import { onMount, onCleanup, createEffect, type Component } from "solid-js";
import uPlot from "uplot";
import { cn } from "../../lib/cn";
import type { SparklineProps } from "../../primitives";

// uPlot's stylesheet is `@import`-ed once from `dashboard/styles.css` so
// every host that loads the dashboard's CSS bundle picks up the chart's
// `.uplot`-prefixed selectors. Importing it here would also work but
// requires a CSS module ambient `.d.ts` shim that we don't otherwise need.

const buildXs = (count: number, periodMs: number): number[] =>
  Array.from({ length: count }, (_, i) => (i * periodMs) / 1000);

export const Sparkline: Component<SparklineProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let plot: uPlot | undefined;

  const samplePeriodMs = (): number => props.samplePeriodMs ?? 1000;
  const height = (): number => props.height ?? 64;
  const colorVar = (): string => props.colorVar ?? "--primary";

  onMount(() => {
    if (!containerRef) return;

    const initialData = props.data;
    const period = samplePeriodMs();
    const accent = colorVar();

    const opts: uPlot.Options = {
      width: containerRef.clientWidth || 100,
      height: height(),
      pxAlign: false,
      cursor: { show: false },
      legend: { show: false },
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

    plot = new uPlot(
      opts,
      [buildXs(initialData.length, period), [...initialData]] as uPlot.AlignedData,
      containerRef,
    );
  });

  onCleanup(() => {
    plot?.destroy();
    plot = undefined;
  });

  createEffect(() => {
    const data = props.data;
    if (!plot) return;
    const period = samplePeriodMs();
    plot.setData([buildXs(data.length, period), [...data]] as uPlot.AlignedData);
  });

  return (
    <div
      ref={containerRef}
      class={cn("w-full", props.class)}
      style={{ height: `${height()}px` }}
    />
  );
};
