/**
 * createDomPrimitives — DOM-host adapter for the dashboard.
 *
 * Builds a `DashboardPrimitives` record over Tailwind v4 + Kobalte + Corvu.
 * Consumed by both:
 *   - `apps/tui` Bun.WebView host (deferred this wave)
 *   - `packages/chrome-ext` popup
 *
 * Each primitive lives in its own file under `./`; this module just
 * bundles them for the `PrimitivesProvider` value. Returning a fresh
 * record on each call (rather than exporting a frozen const) keeps the
 * door open for per-host customization later (e.g., swapping `Sparkline`
 * for an alternate renderer in headless tests) without touching call
 * sites — the provider just gets a different factory wrapper.
 */
import type { DashboardPrimitives } from "../../primitives";
import { Box } from "./Box";
import { Text } from "./Text";
import { Badge } from "./Badge";
import { Progress } from "./Progress";
import { Card } from "./Card";
import { Stat } from "./Stat";
import { Tabs } from "./Tabs";
import { Table } from "./Table";
import { ScrollArea } from "./ScrollArea";
import { Separator } from "./Separator";
import { Layout } from "./Layout";
import { Tooltip } from "./Tooltip";
import { IconButton } from "./IconButton";
import { Sparkline } from "./Sparkline";
import { LogRow } from "./LogRow";

export const createDomPrimitives = (): DashboardPrimitives => ({
  Box,
  Text,
  Badge,
  Progress,
  Card,
  Stat,
  Tabs,
  Table,
  ScrollArea,
  Separator,
  Layout,
  Tooltip,
  IconButton,
  Sparkline,
  LogRow,
});
