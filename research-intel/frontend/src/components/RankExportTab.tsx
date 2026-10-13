import { useEffect, useState } from "react";
import {
  Alert, Button, FormControlLabel, Grid, MenuItem, Paper, Slider, Stack, Switch, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import { api, getToken, type Project } from "../api";
import JobProgress from "./JobProgress";

interface RankingSummary { id: string; version: string; query: string; weights: Record<string, number>;
  snapshot_at: string; paper_count: number; formula: string; params: Record<string, unknown> }
interface ExportRow { id: string; format: string; status: string; row_count: number | null; created_at: string;
  scope: Record<string, unknown>; download_url: string | null; job_id: string | null; error: string | null }

export default function RankExportTab({ project, canEdit, selection, onDone }: { project: Project; canEdit: boolean;
                                                                                 selection: string[]; onDone: () => void }) {
  const [query, setQuery] = useState(project.research_question ?? "");
  const [w, setW] = useState({ lexical: 0.6, semantic: 0.4, recency: 0 });
  const [rankings, setRankings] = useState<RankingSummary[]>([]);
  const [exportsList, setExports] = useState<ExportRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fmt, setFmt] = useState("csv");
  const [recordType, setRecordType] = useState("all");
  const [onlySelected, setOnlySelected] = useState(false);
  const [jobs, setJobs] = useState<string[]>([]);

  const load = () => {
    api.get<RankingSummary[]>(`/projects/${project.id}/rankings`).then(setRankings).catch((e) => setError(e.message));
    api.get<ExportRow[]>(`/projects/${project.id}/exports`).then(setExports).catch((e) => setError(e.message));
  };
  useEffect(load, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rank = async () => {
    setError(null);
    try {
      await api.post(`/projects/${project.id}/rankings`, { query, weights: w });
      load();
      onDone();
    } catch (e) { setError((e as Error).message); }
  };

  const exportNow = async () => {
    setError(null);
    try {
      const e = await api.post<ExportRow>(`/projects/${project.id}/exports`, {
        format: fmt, record_type: recordType, paper_ids: onlySelected ? selection : null,
        idempotency_key: crypto.randomUUID(),
      });
      if (e.job_id) setJobs((j) => [e.job_id!, ...j]);
      load();
    } catch (err) { setError((err as Error).message); }
  };

  const download = async (e: ExportRow) => {
    const res = await fetch(e.download_url!, { headers: { Authorization: `Bearer ${getToken()}` } });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `export-${e.id}-${e.format}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const slider = (k: keyof typeof w, label: string) => (
    <Stack>
      <Typography variant="body2">{label}: {w[k].toFixed(2)}</Typography>
      <Slider size="small" min={0} max={1} step={0.05} value={w[k]} disabled={!canEdit}
              onChange={(_, v) => setW({ ...w, [k]: v as number })} />
    </Stack>
  );

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6">Relevance ranking (rank-v1)</Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            A discovery heuristic, not a quality judgement. Unavailable components are excluded and remaining weights
            renormalised; papers with no text get no score. Citation, journal and author metrics are deferred and never estimated.
          </Typography>
          <Stack spacing={1}>
            <TextField size="small" label="Ranking query" value={query} onChange={(e) => setQuery(e.target.value)} disabled={!canEdit} />
            {slider("lexical", "Keyword match (BM25)")}
            {slider("semantic", "Semantic similarity")}
            {slider("recency", "Publication recency (optional)")}
            {canEdit && <Button variant="contained" onClick={rank} disabled={!query.trim()}>Compute ranking snapshot</Button>}
          </Stack>
          <Table size="small" sx={{ mt: 2 }}>
            <TableHead><TableRow><TableCell>Snapshot</TableCell><TableCell>Query</TableCell><TableCell>Weights</TableCell><TableCell>Papers</TableCell></TableRow></TableHead>
            <TableBody>
              {rankings.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{new Date(r.snapshot_at).toLocaleString()}<Typography variant="caption" display="block">{r.version}</Typography></TableCell>
                  <TableCell>{r.query}</TableCell>
                  <TableCell>{Object.entries(r.weights).map(([k, v]) => `${k} ${v}`).join(", ")}</TableCell>
                  <TableCell>{r.paper_count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Grid>
      <Grid item xs={12} md={6}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6">Export</Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            ZIP with data, manifest.json (queries, sources, dates, filters, ranking, missing-data definitions) and README.
            PDFs are never included.
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
            <TextField select size="small" label="Format" value={fmt} onChange={(e) => setFmt(e.target.value)}>
              <MenuItem value="csv">CSV</MenuItem><MenuItem value="json">JSON</MenuItem>
            </TextField>
            <TextField select size="small" label="Records" value={recordType} onChange={(e) => setRecordType(e.target.value)} sx={{ minWidth: 140 }}>
              <MenuItem value="all">All</MenuItem><MenuItem value="collected">Collected</MenuItem><MenuItem value="discovery">Discovery</MenuItem>
            </TextField>
            <FormControlLabel control={<Switch checked={onlySelected} disabled={!selection.length}
                                               onChange={(e) => setOnlySelected(e.target.checked)} />}
                              label={`Only selected (${selection.length})`} />
            <Button variant="contained" onClick={exportNow}>Export</Button>
          </Stack>
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
          <Stack spacing={1} sx={{ mt: 1 }}>{jobs.map((j) => <JobProgress key={j} jobId={j} canEdit onDone={load} />)}</Stack>
          <Table size="small" sx={{ mt: 2 }}>
            <TableHead><TableRow><TableCell>Created</TableCell><TableCell>Format</TableCell><TableCell>Scope</TableCell><TableCell>Rows</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>
              {exportsList.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{new Date(e.created_at).toLocaleString()}</TableCell>
                  <TableCell>{e.format}</TableCell>
                  <TableCell><Typography variant="caption">{JSON.stringify(e.scope)}</Typography></TableCell>
                  <TableCell>{e.row_count ?? "—"}</TableCell>
                  <TableCell>{e.download_url ? <Button size="small" onClick={() => download(e)}>Download</Button> : e.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Grid>
    </Grid>
  );
}
