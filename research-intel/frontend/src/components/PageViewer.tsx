import { useEffect, useState } from "react";
import { Box, Button, IconButton, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import { api, getToken } from "../api";

interface Props {
  base: string; // /projects/:pid/papers/:paperId
  pageCount: number;
  page: number; // 1-based
  onPage: (p: number) => void;
  highlights: number[][]; // [x0, y0, x1, y1] in PDF points for the current page
  sha256: string;
}

/** Server-rendered page images with bounding-box overlays; independent of any browser PDF plugin. */
export default function PageViewer({ base, pageCount, page, onPage, highlights, sha256 }: Props) {
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/v1${base}/pages/${page - 1}?zoom=1.5`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.statusText);
        const w = Number(r.headers.get("X-Page-Width"));
        const h = Number(r.headers.get("X-Page-Height"));
        url = URL.createObjectURL(await r.blob());
        if (!cancelled) setImg({ url, w, h });
      })
      .catch(() => !cancelled && setImg(null))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [base, page]);

  const openOriginal = async () => {
    const blob = await api.blob(`${base}/pdf`);
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  };

  return (
    <Stack sx={{ height: "100%" }}>
      <Stack direction="row" spacing={1} sx={{ p: 1 }} alignItems="center" flexWrap="wrap">
        <IconButton size="small" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="previous page">‹</IconButton>
        <TextField size="small" type="number" value={page} sx={{ width: 80 }} inputProps={{ min: 1, max: pageCount }}
                   onChange={(e) => onPage(Math.min(pageCount, Math.max(1, Number(e.target.value))))} />
        <Typography variant="body2">of {pageCount}</Typography>
        <IconButton size="small" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="next page">›</IconButton>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>sha256 {sha256.slice(0, 16)}…</Typography>
        <Button size="small" onClick={openOriginal}>Open original PDF</Button>
      </Stack>
      {loading && <LinearProgress />}
      <Box sx={{ flex: 1, overflow: "auto", bgcolor: "#e2e8f0", p: 1 }}>
        {img && (
          <Box sx={{ position: "relative", width: "100%", maxWidth: 900, mx: "auto", boxShadow: 2, bgcolor: "#fff" }}>
            <img src={img.url} alt={`PDF page ${page}`} style={{ width: "100%", display: "block" }} />
            <svg viewBox={`0 0 ${img.w} ${img.h}`} preserveAspectRatio="none"
                 style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
              {highlights.map((b, i) => (
                <rect key={i} x={b[0] - 2} y={b[1] - 2} width={b[2] - b[0] + 4} height={b[3] - b[1] + 4}
                      fill="rgba(250, 204, 21, 0.28)" stroke="#ca8a04" strokeWidth={1} />
              ))}
            </svg>
          </Box>
        )}
      </Box>
    </Stack>
  );
}
