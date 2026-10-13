import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";

interface Props {
  data: Array<Record<string, unknown>>;
  layout: Record<string, unknown>;
  onSelect?: (ids: string[]) => void;
  onClickPoint?: (id: string) => void;
}

/** Minimal Plotly wrapper: renders with Plotly.react and forwards selection / click events as paper ids. */
export default function Plot({ data, layout, onSelect, onClickPoint }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onSelect, onClickPoint });
  handlers.current = { onSelect, onClickPoint };

  useEffect(() => {
    const el = ref.current as (HTMLDivElement & { on?: (ev: string, cb: (e: unknown) => void) => void }) | null;
    if (!el) return;
    Plotly.react(el, data as Plotly.Data[], { autosize: true, ...layout } as Partial<Plotly.Layout>,
      { responsive: true, displaylogo: false });
    el.removeAllListeners?.("plotly_selected");
    el.removeAllListeners?.("plotly_click");
    el.on?.("plotly_selected", (e) => {
      const pts = (e as { points?: Array<{ customdata: string }> } | undefined)?.points ?? [];
      handlers.current.onSelect?.(pts.map((p) => p.customdata));
    });
    el.on?.("plotly_click", (e) => {
      const p = (e as { points: Array<{ customdata: string }> }).points[0];
      if (p) handlers.current.onClickPoint?.(p.customdata);
    });
  }, [data, layout]);

  useEffect(() => () => { if (ref.current) Plotly.purge(ref.current); }, []);
  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}

declare global {
  interface HTMLDivElement {
    removeAllListeners?: (ev: string) => void;
  }
}
