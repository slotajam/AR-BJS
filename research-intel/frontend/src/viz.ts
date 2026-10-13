// Pure helpers for the scatter plot, kept separate so they can be unit tested.
import type { AnalyticsPoint } from "./api";

export interface AxisChoice {
  x: string;
  y: string;
  z?: string;
  color: string;
}

export interface PlotData {
  traces: Array<Record<string, unknown>>;
  plotted: number;
  omitted: number;
  omittedByAxis: Record<string, number>;
}

const PALETTE = ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#65a30d", "#dc2626"];

export function isMissing(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

export function buildTraces(points: AnalyticsPoint[], axes: AxisChoice, selected: Set<string>,
                            mode3d: boolean): PlotData {
  const dims = [axes.x, axes.y, ...(mode3d && axes.z ? [axes.z] : [])];
  const omittedByAxis: Record<string, number> = Object.fromEntries(dims.map((d) => [d, 0]));
  const usable: AnalyticsPoint[] = [];
  for (const p of points) {
    const missing = dims.filter((d) => isMissing(p[d]));
    missing.forEach((d) => (omittedByAxis[d] += 1));
    if (missing.length === 0) usable.push(p);
  }
  const groups = new Map<string, AnalyticsPoint[]>();
  for (const p of usable) {
    const key = String(p[axes.color] ?? "missing");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const traces = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, pts], i) => ({
    type: mode3d ? "scatter3d" : "scattergl",
    mode: "markers",
    name: key,
    x: pts.map((p) => p[axes.x]),
    y: pts.map((p) => p[axes.y]),
    ...(mode3d && axes.z ? { z: pts.map((p) => p[axes.z!]) } : {}),
    customdata: pts.map((p) => p.paper_id),
    text: pts.map((p) => `${p.title ?? "(no title)"}${p.is_fixture ? " [FIXTURE]" : ""}<br>${p.doi ?? "no DOI"}`),
    hovertemplate: "%{text}<br>x=%{x}<br>y=%{y}" + (mode3d ? "<br>z=%{z}" : "") + "<extra>%{fullData.name}</extra>",
    marker: {
      size: pts.map((p) => (selected.has(p.paper_id) ? 11 : 6)),
      color: PALETTE[i % PALETTE.length],
      line: { width: pts.map((p) => (selected.has(p.paper_id) ? 2 : 0)), color: "#111" },
      opacity: selected.size ? 0.9 : 0.75,
    },
  }));
  return { traces, plotted: usable.length, omitted: points.length - usable.length, omittedByAxis };
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function fmtScore(v: number | null | undefined): string {
  return isMissing(v) ? "—" : (v as number).toFixed(3);
}
