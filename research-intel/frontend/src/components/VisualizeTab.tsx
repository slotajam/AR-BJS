import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Box, Button, FormControlLabel, Grid, MenuItem, Paper, Stack, Switch, Table, TableBody, TableCell, TableHead,
  TableRow, TextField, Typography,
} from "@mui/material";
import { api, type Analytics } from "../api";
import { buildTraces, fmtScore, webglAvailable } from "../viz";
import Plot from "./Plot";

interface Props {
  projectId: string;
  version: number;
  selection: string[];
  onSelection: (ids: string[]) => void;
}

export default function VisualizeTab({ projectId, version, selection, onSelection }: Props) {
  const nav = useNavigate();
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gl = useMemo(() => webglAvailable(), []);
  const [mode3d, setMode3d] = useState(gl);
  const [axes, setAxes] = useState({ x: "publication_year", y: "relevance_score", z: "embedding_pc1", color: "record_type" });
  const [recordType, setRecordType] = useState("all");
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    api.get<Analytics>(`/projects/${projectId}/analytics?include_excluded=${includeExcluded}`)
      .then(setData).catch((e) => setError(e.message));
  }, [projectId, version, includeExcluded]);

  const points = useMemo(() => (data?.points ?? []).filter((p) => recordType === "all" || p.record_type === recordType),
    [data, recordType]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const plot = useMemo(() => buildTraces(points, axes, selected, mode3d), [points, axes, selected, mode3d]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;
  const dims = data.dimensions;
  const numeric = Object.entries(dims).filter(([, d]) => d.type === "numeric").map(([k]) => k);
  const categorical = Object.entries(dims).filter(([, d]) => d.type === "categorical").map(([k]) => k);
  const axisTitle = (k: string) => `${dims[k].label}${dims[k].unit ? ` (${dims[k].unit})` : ""}`;
  const fmt = (k: string) => (k === "publication_year" ? { tickformat: "d" } : {});
  const layout = mode3d
    ? { margin: { l: 0, r: 0, t: 10, b: 0 }, uirevision: revision, legend: { orientation: "h" },
        scene: { xaxis: { title: axisTitle(axes.x), ...fmt(axes.x) }, yaxis: { title: axisTitle(axes.y), ...fmt(axes.y) },
                 zaxis: { title: axisTitle(axes.z), ...fmt(axes.z) } } }
    : { margin: { l: 60, r: 10, t: 10, b: 50 }, uirevision: revision, dragmode: "lasso", legend: { orientation: "h" },
        xaxis: { title: { text: axisTitle(axes.x) }, ...fmt(axes.x) }, yaxis: { title: { text: axisTitle(axes.y) }, ...fmt(axes.y) } };
  const tableRows = (selection.length ? points.filter((p) => selected.has(p.paper_id)) : points)
    .slice().sort((a, b) => (b.relevance_score ?? -1) - (a.relevance_score ?? -1)).slice(0, 100);
  const sel = (k: keyof typeof axes, options: string[]) => (
    <TextField select size="small" label={k.toUpperCase()} value={axes[k]} sx={{ minWidth: 170 }}
               onChange={(e) => setAxes({ ...axes, [k]: e.target.value })}>
      {options.map((o) => <MenuItem key={o} value={o}>{dims[o].label}</MenuItem>)}
    </TextField>
  );

  return (
    <Stack spacing={1.5}>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }} flexWrap="wrap">
          {sel("x", numeric)}{sel("y", numeric)}{mode3d && sel("z", numeric)}{sel("color", categorical)}
          <TextField select size="small" label="Records" value={recordType} onChange={(e) => setRecordType(e.target.value)} sx={{ minWidth: 140 }}>
            <MenuItem value="all">All</MenuItem><MenuItem value="collected">Collected</MenuItem><MenuItem value="discovery">Discovery</MenuItem>
          </TextField>
          <FormControlLabel control={<Switch checked={mode3d} disabled={!gl} onChange={(e) => setMode3d(e.target.checked)} />}
                            label={gl ? "3D" : "3D unavailable (no WebGL) — 2D fallback"} />
          <FormControlLabel control={<Switch checked={includeExcluded} onChange={(e) => setIncludeExcluded(e.target.checked)} />} label="Include excluded" />
          <Button size="small" onClick={() => { onSelection([]); setRevision((r) => r + 1); }}>Reset view & selection</Button>
        </Stack>
      </Paper>
      <Grid container spacing={1.5}>
        <Grid item xs={12} lg={8}>
          <Paper variant="outlined" sx={{ height: 560, p: 1 }}>
            <Plot data={plot.traces} layout={layout} onSelect={onSelection}
                  onClickPoint={(id) => nav(`/projects/${projectId}/papers/${id}`)} />
          </Paper>
          <Typography variant="caption" color="text.secondary">
            {mode3d ? "Drag to rotate, scroll to zoom." : "Lasso/box-select to select papers (shared with the Library tab)."} Click a point to open the paper.
          </Typography>
        </Grid>
        <Grid item xs={12} lg={4}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="subtitle2">Disclosure</Typography>
            <Typography variant="body2">Plotted {plot.plotted} of {points.length} papers; {plot.omitted} omitted for missing axis values
              {Object.entries(plot.omittedByAxis).filter(([, n]) => n).map(([d, n]) => ` (${dims[d].label}: ${n} missing)`).join("")}.
              {data.excluded_hidden > 0 && ` ${data.excluded_hidden} excluded papers hidden.`}</Typography>
            <Box component="ul" sx={{ pl: 2, my: 1 }}>
              {[axes.x, axes.y, ...(mode3d ? [axes.z] : [])].map((k) => (
                <li key={k}><Typography variant="caption"><b>{dims[k].label}</b> — unit: {dims[k].unit ?? "n/a"}; transform: {dims[k].transform}</Typography></li>
              ))}
            </Box>
            <Typography variant="caption" display="block">
              Embeddings: {data.embedding.provider}/{data.embedding.model}
              {data.embedding.is_semantic ? "" : " — lexical hashing proxy, not a semantic model"}.
              {data.embedding.pca_explained_variance && ` PCA explained variance: ${data.embedding.pca_explained_variance.join(", ")}.`}
              {data.embedding.pca_note && ` ${data.embedding.pca_note}.`}
            </Typography>
            <Typography variant="caption" display="block">
              Scores: {data.ranking ? `${data.ranking.version} snapshot ${new Date(data.ranking.snapshot_at).toLocaleString()} for “${data.ranking.query}”` : "no ranking yet (run one in Rank & export)"}.
            </Typography>
            {data.notes.map((n) => <Typography key={n} variant="caption" display="block" color="text.secondary">{n}</Typography>)}
          </Paper>
        </Grid>
      </Grid>
      <Paper variant="outlined">
        <Table size="small">
          <TableHead><TableRow>
            <TableCell>{selection.length ? `Selected (${selection.length})` : "Top papers"}</TableCell>
            <TableCell>Year</TableCell><TableCell>Score</TableCell><TableCell>Record</TableCell><TableCell>Access</TableCell><TableCell>Source</TableCell>
          </TableRow></TableHead>
          <TableBody>
            {tableRows.map((p) => (
              <TableRow key={p.paper_id} hover sx={{ cursor: "pointer" }} onClick={() => nav(`/projects/${projectId}/papers/${p.paper_id}`)}>
                <TableCell>{p.title ?? "(no title)"}{p.is_fixture ? " [FIXTURE]" : ""}</TableCell>
                <TableCell>{p.publication_year ?? "—"}</TableCell><TableCell>{fmtScore(p.relevance_score)}</TableCell>
                <TableCell>{p.record_type}</TableCell><TableCell>{p.access_status}</TableCell><TableCell>{p.source}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
