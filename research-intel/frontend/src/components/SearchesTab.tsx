import { useEffect, useState } from "react";
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Button, Checkbox, Chip, FormControlLabel, FormGroup, Grid,
  MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import { api, type Search } from "../api";
import JobProgress from "./JobProgress";

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

function parseSynonyms(text: string): Record<string, string[]> {
  // one line per keyword: "battery: cell, accumulator"
  const out: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const [k, v] = line.split(":");
    if (k?.trim() && v) out[k.trim()] = splitList(v);
  }
  return out;
}

export default function SearchesTab({ projectId, canEdit, onDone }: { projectId: string; canEdit: boolean;
                                                                       onDone: () => void }) {
  const [searches, setSearches] = useState<Search[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [f, setF] = useState({
    name: "", original_query: "", keywords: "", synonyms: "", boolean_query: "", date_from: "", date_to: "",
    languages: "", document_types: "", inclusion_criteria: "", exclusion_criteria: "", exclusion_terms: "",
    result_limit: 200, pdf_mode: "metadata_only", openalex: true, crossref: true,
  });

  const load = () => api.get<Search[]>(`/projects/${projectId}/searches`).then(setSearches).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setError(null);
    try {
      const s = await api.post<Search>(`/projects/${projectId}/searches`, {
        name: f.name || f.original_query.slice(0, 60), original_query: f.original_query,
        keywords: splitList(f.keywords), synonyms: parseSynonyms(f.synonyms),
        boolean_query: f.boolean_query || null, date_from: f.date_from || null, date_to: f.date_to || null,
        languages: splitList(f.languages), document_types: splitList(f.document_types),
        inclusion_criteria: f.inclusion_criteria || null, exclusion_criteria: f.exclusion_criteria || null,
        exclusion_terms: splitList(f.exclusion_terms), result_limit: Number(f.result_limit), pdf_mode: f.pdf_mode,
        sources: [f.openalex && "openalex", f.crossref && "crossref"].filter(Boolean),
        idempotency_key: crypto.randomUUID(),
      });
      setActiveJob(s.jobs[0]?.id ?? null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <Stack spacing={2}>
      {canEdit && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>New search</Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={8}><TextField fullWidth required label="Research question / query" value={f.original_query} onChange={set("original_query")} /></Grid>
            <Grid item xs={12} md={4}><TextField fullWidth label="Search name" value={f.name} onChange={set("name")} /></Grid>
            <Grid item xs={12} md={6}><TextField fullWidth label="Keywords (comma separated)" value={f.keywords} onChange={set("keywords")} /></Grid>
            <Grid item xs={12} md={6}><TextField fullWidth multiline label="Synonyms (keyword: syn1, syn2 — one per line)" value={f.synonyms} onChange={set("synonyms")} /></Grid>
            <Grid item xs={12}><TextField fullWidth label="Boolean query (overrides keywords; AND / OR / NOT)" value={f.boolean_query} onChange={set("boolean_query")}
                                          helperText="OpenAlex receives boolean syntax; Crossref does not support it, so operators are removed there (recorded per run)." /></Grid>
            <Grid item xs={6} md={3}><TextField fullWidth type="date" label="From" InputLabelProps={{ shrink: true }} value={f.date_from} onChange={set("date_from")} /></Grid>
            <Grid item xs={6} md={3}><TextField fullWidth type="date" label="To" InputLabelProps={{ shrink: true }} value={f.date_to} onChange={set("date_to")} /></Grid>
            <Grid item xs={6} md={3}><TextField fullWidth label="Languages (ISO, e.g. en, th)" value={f.languages} onChange={set("languages")} /></Grid>
            <Grid item xs={6} md={3}><TextField fullWidth label="Document types (article, preprint…)" value={f.document_types} onChange={set("document_types")} /></Grid>
            <Grid item xs={12} md={6}><TextField fullWidth multiline label="Inclusion criteria (recorded)" value={f.inclusion_criteria} onChange={set("inclusion_criteria")} /></Grid>
            <Grid item xs={12} md={6}><TextField fullWidth multiline label="Exclusion criteria (recorded)" value={f.exclusion_criteria} onChange={set("exclusion_criteria")} /></Grid>
            <Grid item xs={12} md={6}><TextField fullWidth label="Exclusion terms (auto-flag in title/abstract)" value={f.exclusion_terms} onChange={set("exclusion_terms")} /></Grid>
            <Grid item xs={6} md={2}><TextField fullWidth type="number" label="Limit per source" value={f.result_limit} onChange={set("result_limit")} /></Grid>
            <Grid item xs={6} md={4}>
              <TextField select fullWidth label="PDF acquisition" value={f.pdf_mode} onChange={set("pdf_mode")}>
                <MenuItem value="metadata_only">Metadata only</MenuItem>
                <MenuItem value="permitted_oa">Collect permitted open-access PDFs</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12}>
              <FormGroup row>
                <FormControlLabel control={<Checkbox checked={f.openalex} onChange={(e) => setF({ ...f, openalex: e.target.checked })} />} label="OpenAlex" />
                <FormControlLabel control={<Checkbox checked={f.crossref} onChange={(e) => setF({ ...f, crossref: e.target.checked })} />} label="Crossref" />
                <FormControlLabel disabled control={<Checkbox checked={false} />} label="AI query expansion (Phase 2)" />
              </FormGroup>
            </Grid>
          </Grid>
          <Button variant="contained" onClick={submit} disabled={!f.original_query}>Run search</Button>
        </Paper>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {activeJob && <JobProgress jobId={activeJob} canEdit={canEdit} onDone={() => { load(); onDone(); }} />}
      {searches.map((s) => (
        <Accordion key={s.id} variant="outlined" disableGutters>
          <AccordionSummary>
            <Stack>
              <Typography fontWeight={600}>{s.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {new Date(s.created_at).toLocaleString()} · {s.sources.join(", ")} · last job: {s.jobs[0]?.status ?? "never run"}
              </Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2"><b>Original query:</b> {s.original_query}</Typography>
            <Typography variant="body2"><b>Expanded ({s.expanded_query?.version}, {s.expanded_query?.basis}):</b> <code>{s.expanded_query?.text}</code></Typography>
            <Table size="small" sx={{ mt: 1 }}>
              <TableHead><TableRow>
                <TableCell>Run</TableCell><TableCell>Source</TableCell><TableCell>Status</TableCell><TableCell>Exact query sent</TableCell>
                <TableCell>Retrieved</TableCell><TableCell>New</TableCell><TableCell>Duplicates</TableCell><TableCell>Excluded</TableCell>
                <TableCell>Failures</TableCell><TableCell>Coverage</TableCell><TableCell>Started → completed</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {s.runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><code>{r.id.slice(0, 8)}</code></TableCell>
                    <TableCell>{r.source} <Typography variant="caption">{r.connector_version}</Typography></TableCell>
                    <TableCell><Chip size="small" label={r.status} color={r.status === "completed" ? "success" : r.status === "skipped" ? "default" : "warning"} /></TableCell>
                    <TableCell><code>{r.exact_query}</code></TableCell>
                    <TableCell>{r.retrieved_count} / {r.result_limit}{r.pagination.total_available != null && ` (of ${r.pagination.total_available})`}</TableCell>
                    <TableCell>{r.new_count}</TableCell><TableCell>{r.duplicate_count}</TableCell>
                    <TableCell>{r.exclusion_count}</TableCell><TableCell>{r.failure_count}</TableCell>
                    <TableCell>{r.partial_coverage ? <Chip size="small" color="warning" label="partial" /> : "complete"}
                      {r.errors.length > 0 && <Typography variant="caption" display="block">{r.errors[r.errors.length - 1]}</Typography>}</TableCell>
                    <TableCell>{r.started_at ? new Date(r.started_at).toLocaleTimeString() : "—"} → {r.completed_at ? new Date(r.completed_at).toLocaleTimeString() : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {canEdit && (
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <Button size="small" onClick={async () => setActiveJob((await api.post<{ id: string }>(`/searches/${s.id}/run`)).id)}>Run again</Button>
                {s.jobs[0] && ["failed", "partial", "cancelled"].includes(s.jobs[0].status) &&
                  <Button size="small" onClick={async () => setActiveJob((await api.post<{ id: string }>(`/jobs/${s.jobs[0].id}/retry`)).id)}>Resume last job</Button>}
              </Stack>
            )}
          </AccordionDetails>
        </Accordion>
      ))}
    </Stack>
  );
}
