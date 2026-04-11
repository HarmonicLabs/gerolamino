/**
 * OpenTUI implementation of DashboardPrimitives.
 *
 * Maps abstract dashboard primitives to OpenTUI constructs:
 * <box>, <text>, <scrollbox>, <tab_select>, etc.
 */
import { For, Show } from "solid-js";
import type { DashboardPrimitives } from "dashboard";

/** OpenTUI primitives for the terminal dashboard. */
export const tuiPrimitives: DashboardPrimitives = {
  Box: (props) => (
    <box
      style={{
        flexDirection: props.direction ?? "column",
        gap: props.gap ?? 0,
        padding: props.padding ?? 0,
        flexGrow: props.grow ?? 0,
        ...(props.border ? { border: true, borderStyle: "single" } : {}),
      }}
    >
      {props.children}
    </box>
  ),

  Text: (props) => {
    const colorMap = {
      default: undefined,
      muted: "#888888",
      success: "#00cc00",
      warning: "#cccc00",
      error: "#cc0000",
      accent: "#00cccc",
    };
    return (
      <text
        style={{
          fg: colorMap[props.color ?? "default"],
          ...(props.weight === "bold" ? { attributes: { bold: true } } : {}),
        }}
      >
        {props.children}
      </text>
    );
  },

  Badge: (props) => {
    const colorMap = {
      default: "#aaaaaa",
      success: "#00cc00",
      warning: "#cccc00",
      error: "#cc0000",
      outline: "#888888",
    };
    return (
      <text style={{ fg: colorMap[props.variant], attributes: { bold: true } }}>
        [{props.children}]
      </text>
    );
  },

  Progress: (props) => {
    const max = props.max ?? 100;
    const pct = Math.min(Math.max(props.value / max, 0), 1);
    const barWidth = 40;
    const filled = Math.round(pct * barWidth);
    const empty = barWidth - filled;
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
    return (
      <text>
        {bar} {Math.round(pct * 100)}%
      </text>
    );
  },

  Card: (props) => (
    <box style={{ border: true, borderStyle: "single", padding: 1 }}>
      <Show when={props.title}>
        <text style={{ attributes: { bold: true } }}>{props.title}</text>
      </Show>
      <Show when={props.description}>
        <text style={{ fg: "#888888" }}>{props.description}</text>
      </Show>
      {props.children}
    </box>
  ),

  Stat: (props) => (
    <box style={{ flexDirection: "column" }}>
      <text style={{ fg: "#888888" }}>{props.label}</text>
      <text style={{ attributes: { bold: true } }}>
        {props.trend === "up" ? "\u25b2 " : props.trend === "down" ? "\u25bc " : ""}
        {String(props.value)}
      </text>
      <Show when={props.description}>
        <text style={{ fg: "#666666" }}>{props.description}</text>
      </Show>
    </box>
  ),

  Tabs: (props) => (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row", gap: 2, paddingBottom: 1 }}>
        <For each={[...props.tabs]}>
          {(tab) => (
            <text
              style={{
                fg: tab.value === props.selected ? "#00cccc" : "#888888",
                attributes: { bold: tab.value === props.selected },
              }}
            >
              {tab.label}
            </text>
          )}
        </For>
      </box>
      {props.children}
    </box>
  ),

  Table: (props) => {
    const rows = props.data;
    const cols = props.columns;
    return (
      <box style={{ flexDirection: "column" }}>
        {/* Header */}
        <box style={{ flexDirection: "row", gap: 2 }}>
          <For each={[...cols]}>
            {(col) => (
              <text style={{ fg: "#888888", attributes: { bold: true } }}>
                {col.header}
              </text>
            )}
          </For>
        </box>
        {/* Rows */}
        <For each={[...rows]}>
          {(row) => (
            <box style={{ flexDirection: "row", gap: 2 }}>
              <For each={[...cols]}>
                {(col) => <text>{String(col.accessor(row))}</text>}
              </For>
            </box>
          )}
        </For>
      </box>
    );
  },

  ScrollArea: (props) => (
    <scrollbox
      style={{ flexGrow: 1 }}
      scrollbarOptions={{ visible: true }}
    >
      {props.children}
    </scrollbox>
  ),

  Separator: () => (
    <text style={{ fg: "#444444" }}>
      {"\u2500".repeat(60)}
    </text>
  ),
};
