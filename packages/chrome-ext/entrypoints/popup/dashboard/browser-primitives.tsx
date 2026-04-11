/**
 * Browser implementation of DashboardPrimitives.
 *
 * Uses plain HTML elements with Tailwind-compatible inline styles.
 * Kobalte components (Progress, Tabs) used where available.
 * solid-primitives used for browser-only features in the popup.
 */
import { For, Show } from "solid-js";
import type { DashboardPrimitives } from "dashboard";

const colorMap = {
  default: "inherit",
  muted: "#9ca3af",
  success: "#22c55e",
  warning: "#eab308",
  error: "#ef4444",
  accent: "#06b6d4",
};

const badgeColors = {
  default: { bg: "#374151", fg: "#d1d5db" },
  success: { bg: "#14532d", fg: "#22c55e" },
  warning: { bg: "#422006", fg: "#eab308" },
  error: { bg: "#450a0a", fg: "#ef4444" },
  outline: { bg: "transparent", fg: "#9ca3af" },
};

/** Browser primitives for the Chrome extension popup. */
export const browserPrimitives: DashboardPrimitives = {
  Box: (props) => (
    <div
      style={{
        display: "flex",
        "flex-direction": props.direction ?? "column",
        gap: `${props.gap ?? 0}px`,
        padding: props.padding ? `${props.padding * 8}px` : undefined,
        "flex-grow": props.grow ?? 0,
        ...(props.border ? { border: "1px solid #374151", "border-radius": "8px" } : {}),
      }}
    >
      {props.children}
    </div>
  ),

  Text: (props) => (
    <span
      style={{
        color: colorMap[props.color ?? "default"],
        "font-weight": props.weight === "bold" ? "bold" : "normal",
        "font-size":
          props.size === "xs"
            ? "10px"
            : props.size === "sm"
              ? "12px"
              : props.size === "lg"
                ? "18px"
                : props.size === "xl"
                  ? "24px"
                  : "14px",
      }}
    >
      {props.children}
    </span>
  ),

  Badge: (props) => {
    const colors = () => badgeColors[props.variant];
    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          "border-radius": "9999px",
          "font-size": "11px",
          "font-weight": "600",
          "background-color": colors().bg,
          color: colors().fg,
          ...(props.variant === "outline" ? { border: "1px solid #4b5563" } : {}),
        }}
      >
        {props.children}
      </span>
    );
  },

  Progress: (props) => {
    const max = props.max ?? 100;
    const pct = () => Math.min(Math.max(props.value / max, 0), 1) * 100;
    return (
      <div
        style={{
          width: "100%",
          height: "8px",
          "background-color": "#1f2937",
          "border-radius": "4px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct()}%`,
            height: "100%",
            "background-color": "#06b6d4",
            "border-radius": "4px",
            transition: "width 300ms ease",
          }}
        />
      </div>
    );
  },

  Card: (props) => (
    <div
      style={{
        border: "1px solid #374151",
        "border-radius": "8px",
        padding: "12px",
        "background-color": "#111827",
      }}
    >
      <Show when={props.title}>
        <div style={{ "font-weight": "bold", "margin-bottom": "4px", color: "#f3f4f6" }}>
          {props.title}
        </div>
      </Show>
      <Show when={props.description}>
        <div style={{ color: "#9ca3af", "font-size": "12px", "margin-bottom": "8px" }}>
          {props.description}
        </div>
      </Show>
      {props.children}
    </div>
  ),

  Stat: (props) => (
    <div style={{ "min-width": "80px" }}>
      <div style={{ color: "#9ca3af", "font-size": "11px", "text-transform": "uppercase" }}>
        {props.label}
      </div>
      <div style={{ "font-weight": "bold", "font-size": "16px", color: "#f3f4f6" }}>
        {props.trend === "up" ? "\u25b2 " : props.trend === "down" ? "\u25bc " : ""}
        {String(props.value)}
      </div>
      <Show when={props.description}>
        <div style={{ color: "#6b7280", "font-size": "11px" }}>{props.description}</div>
      </Show>
    </div>
  ),

  Tabs: (props) => (
    <div style={{ display: "flex", "flex-direction": "column" }}>
      <div
        style={{
          display: "flex",
          gap: "4px",
          "border-bottom": "1px solid #374151",
          "padding-bottom": "8px",
          "margin-bottom": "12px",
        }}
      >
        <For each={[...props.tabs]}>
          {(tab) => (
            <button
              onClick={() => props.onSelect(tab.value)}
              style={{
                padding: "4px 12px",
                "border-radius": "4px",
                border: "none",
                cursor: "pointer",
                "font-size": "13px",
                "background-color": tab.value === props.selected ? "#1e3a5f" : "transparent",
                color: tab.value === props.selected ? "#38bdf8" : "#9ca3af",
                "font-weight": tab.value === props.selected ? "bold" : "normal",
              }}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      {props.children}
    </div>
  ),

  Table: (props) => (
    <table
      style={{
        width: "100%",
        "border-collapse": "collapse",
        "font-size": "12px",
      }}
    >
      <thead>
        <tr>
          <For each={[...props.columns]}>
            {(col) => (
              <th
                style={{
                  "text-align": col.align ?? "left",
                  padding: "4px 8px",
                  color: "#9ca3af",
                  "border-bottom": "1px solid #374151",
                  "font-weight": "600",
                }}
              >
                {col.header}
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={[...props.data]}>
          {(row) => (
            <tr>
              <For each={[...props.columns]}>
                {(col) => (
                  <td
                    style={{
                      "text-align": col.align ?? "left",
                      padding: "4px 8px",
                      color: "#e5e7eb",
                    }}
                  >
                    {String(col.accessor(row))}
                  </td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  ),

  ScrollArea: (props) => (
    <div
      style={{
        "max-height":
          typeof props.maxHeight === "number"
            ? `${props.maxHeight}px`
            : (props.maxHeight ?? "400px"),
        "overflow-y": "auto",
      }}
    >
      {props.children}
    </div>
  ),

  Separator: () => (
    <hr style={{ border: "none", "border-top": "1px solid #374151", margin: "8px 0" }} />
  ),
};
