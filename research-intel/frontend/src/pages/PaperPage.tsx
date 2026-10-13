import { useEffect, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import {
  Alert, Box, Breadcrumbs, Button, Chip, Grid, Link, MenuItem, Paper, Stack, Tab, Table, TableBody, TableCell,
  TableHead, TableRow, Tabs, TextField, Typography,
} from "@mui/material";
import { api } from "../api";
import PageViewer from "../components/PageViewer";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = Record<string, any>;
interface ChunkRow { id: string; page_index: number; pdf_page_number: number; printed_page: string | null;
  section_label: string | null; text: string; char_start: number; char_end: number; bboxes: number[][] }

const Missing = ({ reason }: { reason?: string }) => (
  <Typography component="span" variant="body2" color="text.disabled">— {reason ? `(${reason})` : "(not supplied)"}</Typography>
);

export default function PaperPage() {
  const { projectId, paperId } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState("overview");
  const [page, setPage] = useState(1);
  const [highlight, setHighlight] = useState<{ page: number; boxes: number[][] }>({ page: 0, boxes: [] });
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [evidence, setEvidence] = useState<Detail | null>(null);
  const [evQuery, setEvQuery] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null); // load failure: replaces the page
  const [actionError, setActionError] = useState<string | null>(null); // failed action: shown inline
  const base = `/projects/${projectId}/papers/${paperId}`;

  const load = () => api.get<Detail>(base).then(setD).catch((e) => setError(e.message));
  const loadEvidence = (q?: string) =>
    api.get<Detail>(`${base}/evidence${q ? `?query=${encodeURIComponent(q)}` : ""}`).then(setEvidence);
  useEffect(() => { load(); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!d?.file) return;
    api.get<ChunkRow[]>(`${base}/chunks`).then(setChunks);
    loadEvidence();
  }, [d?.file?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Jump the viewer to a page and outline the boxes of the passage. */
  const show = (pageNumber: number, boxes: number[][] = []) => {
    setPage(pageNumber);
    setHighlight({ page: pageNumber, boxes });
  };
  const chunkBoxes = (chunkId: string) => chunks.find((c) => c.id === chunkId)?.bboxes ?? [];

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!d) return null;
  const canEdit = true; // server enforces roles; failed writes surface as errors

  const saveSelection = async (c: ChunkRow) => {
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    const idx = text ? c.text.indexOf(text) : -1;
    if (idx < 0) { setActionError("Select text inside this passage first."); return; }
    try {
      await api.post(`${base}/evidence`, { chunk_id: c.id, char_start: c.char_start + idx,
        char_end: c.char_start + idx + text.length });
      loadEvidence(evQuery || undefined);
      setActionError(null);
    } catch (e) { setActionError((e as Error).message); }
  };

  const field = (label: string, key: string, v?: any) => {
    const val = v ?? d[key];
    const corrected = d.effective_values?.[key];
    return (
      <TableRow>
        <TableCell sx={{ width: 170, fontWeight: 600 }}>{label}</TableCell>
        <TableCell>
          {val === null || val === undefined || val === "" || (Array.isArray(val) && !val.length)
            ? <Missing reason={d.missing_reasons?.[key]} /> : String(Array.isArray(val) ? val.join(", ") : val)}
          {corrected !== undefined && <Chip size="small" color="info" sx={{ ml: 1 }} label={`user correction: ${corrected}`} />}
          {d.conflicts?.[key] && <Chip size="small" color="warning" sx={{ ml: 1 }}
                                        label={`conflict: ${d.conflicts[key].map((c: any) => `${c.source}=${c.value}`).join("; ")}`} />}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <Stack spacing={2}>
      <Breadcrumbs>
        <Link component={RouterLink} to={`/projects/${projectId}`}>Project</Link>
        <Typography>{d.doi ?? d.id.slice(0, 8)}</Typography>
      </Breadcrumbs>
      <Box>
        <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap">
          <Chip label={d.record_type} color={d.record_type === "collected" ? "success" : "default"} />
          <Chip label={`access: ${d.access_status}`} variant="outlined" />
          {d.processing_status && <Chip label={`processing: ${d.processing_status}`} variant="outlined" />}
          {d.is_fixture && <Chip color="warning" label="FIXTURE / demo data" />}
          {d.is_retracted && <Chip color="error" label="RETRACTED (per source)" />}
          {d.excluded && <Chip color="default" label={`excluded: ${d.exclusion_reason ?? ""}`} />}
        </Stack>
        <Typography variant="h5">{d.title ?? <Missing reason={d.missing_reasons?.title} />}</Typography>
        <Typography color="text.secondary">{d.authors.map((a: any) => a.display_name).join(", ")}</Typography>
      </Box>
      {actionError && <Alert severity="error" onClose={() => setActionError(null)}>{actionError}</Alert>}
      <Grid container spacing={2}>
        <Grid item xs={12} lg={6}>
          <Paper variant="outlined" sx={{ height: { xs: 480, lg: "calc(100vh - 240px)" }, display: "flex", flexDirection: "column" }}>
            {d.file ? (
              <PageViewer base={base} pageCount={d.file.page_count} page={page} sha256={d.file.sha256}
                          onPage={setPage} highlights={highlight.page === page ? highlight.boxes : []} />
            ) : (
              <Box sx={{ p: 3 }}>
                <Typography variant="h6">No collected PDF</Typography>
                <Typography color="text.secondary" gutterBottom>
                  This is a discovery record (metadata only). Full text, evidence and chunk embeddings require a
                  validated PDF from a permitted source or an attested upload.
                </Typography>
                {d.access_records.some((a: any) => a.permitted) && (
                  <Button variant="contained" onClick={async () => { await api.post(`${base}/collect`, { idempotency_key: crypto.randomUUID() }); load(); }}>
                    Collect permitted PDF
                  </Button>
                )}
              </Box>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} lg={6}>
          <Paper variant="outlined">
            <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable">
              <Tab value="overview" label="Metadata" /><Tab value="evidence" label="Evidence" />
              <Tab value="text" label={`Text (${d.chunk_count})`} /><Tab value="provenance" label="Provenance" />
              <Tab value="access" label="Access & file" /><Tab value="notes" label={`Notes (${d.notes.length})`} />
            </Tabs>
            <Box sx={{ p: 2, maxHeight: { lg: "calc(100vh - 300px)" }, overflow: "auto" }}>
              {tab === "overview" && (
                <>
                  <Table size="small"><TableBody>
                    {field("DOI", "doi")}{field("Venue", "venue")}{field("Year", "publication_year")}
                    {field("Date", "publication_date")}{field("Type", "document_type")}{field("Language", "language")}
                    {field("Licence", "license")}{field("Keywords", "keywords")}{field("Cited by (provider)", "cited_by_count")}
                    {field("Retracted", "is_retracted")}
                    <TableRow><TableCell sx={{ fontWeight: 600 }}>Affiliations</TableCell><TableCell>
                      {d.authors.flatMap((a: any) => a.affiliations.map((af: any) => `${af.name}${af.country_code ? ` (${af.country_code})` : ""}`)).filter(Boolean).join("; ") || <Missing />}
                    </TableCell></TableRow>
                  </TableBody></Table>
                  <Typography variant="subtitle2" sx={{ mt: 2 }}>Abstract</Typography>
                  <Typography variant="body2">{d.abstract ?? <Missing reason={d.missing_reasons?.abstract} />}</Typography>
                  {d.score && (
                    <Paper variant="outlined" sx={{ p: 1.5, mt: 2 }}>
                      <Typography variant="subtitle2">Relevance {d.score.value?.toFixed(3) ?? "— (no score)"} · rank {d.score.rank ?? "—"} · coverage {d.score.coverage}</Typography>
                      <Typography variant="caption" display="block">{d.score.version}, snapshot {new Date(d.score.snapshot_at).toLocaleString()}, query “{d.score.query}”, text basis {d.score.text_basis}</Typography>
                      <Table size="small"><TableHead><TableRow><TableCell>Component</TableCell><TableCell>Value</TableCell><TableCell>Effective weight</TableCell><TableCell>Detail</TableCell></TableRow></TableHead>
                        <TableBody>{Object.entries(d.score.components).map(([k, c]: [string, any]) => (
                          <TableRow key={k}><TableCell>{k}</TableCell><TableCell>{c.value ?? "unavailable"}</TableCell>
                            <TableCell>{d.score.effective_weights[k] ?? 0}</TableCell>
                            <TableCell><Typography variant="caption">{JSON.stringify({ ...c, value: undefined })}</Typography></TableCell></TableRow>
                        ))}</TableBody></Table>
                    </Paper>
                  )}
                  {d.relations.length > 0 && <Alert severity="info" sx={{ mt: 2 }}>
                    Linked versions: {d.relations.map((r: any) => `${r.relation} (${r.basis})`).join("; ")}</Alert>}
                  {canEdit && <CorrectionForm base={base} onSaved={load} />}
                </>
              )}
              {tab === "evidence" && (
                <>
                  {!d.file && <Alert severity="info">Evidence requires a collected PDF.</Alert>}
                  {d.file && (
                    <>
                      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                        <TextField size="small" fullWidth label="Find passages for terms" value={evQuery} onChange={(e) => setEvQuery(e.target.value)} />
                        <Button onClick={() => loadEvidence(evQuery || undefined)}>Find</Button>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">{evidence?.note}</Typography>
                      <Typography variant="subtitle2" sx={{ mt: 1 }}>Saved evidence</Typography>
                      {evidence?.saved.length === 0 && <Typography variant="body2" color="text.secondary">None yet — select text in the Text tab and save it.</Typography>}
                      {evidence?.saved.map((e: any) => (
                        <Paper key={e.id} variant="outlined" sx={{ p: 1, my: 0.5, cursor: "pointer" }} onClick={() => show(e.pdf_page_number, chunkBoxes(e.chunk_id))}>
                          <Typography variant="body2">“{e.quote}”</Typography>
                          <Typography variant="caption">PDF p.{e.pdf_page_number}{e.printed_page ? ` (printed ${e.printed_page})` : ""} · {e.section_label ?? "no section"} · chars {e.char_start}–{e.char_end}</Typography>
                        </Paper>
                      ))}
                      <Typography variant="subtitle2" sx={{ mt: 1 }}>Term matches ({evidence?.query_terms?.join(", ")})</Typography>
                      {evidence?.matches.map((m: any) => (
                        <Paper key={m.chunk_id} variant="outlined" sx={{ p: 1, my: 0.5, cursor: "pointer" }} onClick={() => show(m.pdf_page_number, m.bboxes)}>
                          <Typography variant="body2">…{m.snippet}…</Typography>
                          <Typography variant="caption">PDF p.{m.pdf_page_number}{m.printed_page ? ` (printed ${m.printed_page})` : ""} · {m.section_label ?? "no section"} · matched: {m.matched_terms.join(", ")}</Typography>
                        </Paper>
                      ))}
                    </>
                  )}
                </>
              )}
              {tab === "text" && (
                <>
                  {d.unsupported_content && <Alert severity="warning" sx={{ mb: 1 }}>
                    Not extracted in Phase 1: {d.unsupported_content.join(", ").replaceAll("_", " ")}. Text is PyMuPDF block text; scanned pages without a text layer appear empty (OCR deferred).
                  </Alert>}
                  {d.file?.validation?.extraction?.pages_without_text?.length > 0 && <Alert severity="info">Pages without extractable text: {d.file.validation.extraction.pages_without_text.map((p: number) => p + 1).join(", ")}</Alert>}
                  {chunks.map((c) => (
                    <Paper key={c.id} variant="outlined" sx={{ p: 1, my: 0.5 }} data-chunk-id={c.id}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Link component="button" variant="caption" onClick={() => show(c.pdf_page_number, c.bboxes)}>
                          PDF p.{c.pdf_page_number}{c.printed_page ? ` (printed ${c.printed_page})` : ""} · {c.section_label ?? "—"} · chars {c.char_start}–{c.char_end}
                        </Link>
                        {canEdit && <Button size="small" onMouseDown={(e) => e.preventDefault()} onClick={() => saveSelection(c)}>
                          Save selection as evidence</Button>}
                      </Stack>
                      <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>{c.text}</Typography>
                    </Paper>
                  ))}
                </>
              )}
              {tab === "provenance" && (
                <Table size="small">
                  <TableHead><TableRow><TableCell>Source</TableCell><TableCell>Retrieved</TableCell><TableCell>Record ID</TableCell><TableCell>Search run</TableCell><TableCell>Exact query</TableCell><TableCell>Matched by</TableCell></TableRow></TableHead>
                  <TableBody>{d.provenance.map((o: any) => (
                    <TableRow key={o.id}><TableCell>{o.source}</TableCell><TableCell>{new Date(o.retrieved_at).toLocaleString()}</TableCell>
                      <TableCell>{o.source_record_id ?? "—"}</TableCell><TableCell><code>{o.search_run_id?.slice(0, 8) ?? "—"}</code></TableCell>
                      <TableCell><code>{o.exact_query ?? "—"}</code></TableCell><TableCell>{o.dedup_basis}</TableCell></TableRow>
                  ))}</TableBody>
                  <TableHead><TableRow><TableCell colSpan={6}>Identifiers</TableCell></TableRow></TableHead>
                  <TableBody>{d.identifiers.map((i: any) => <TableRow key={i.scheme + i.value}><TableCell>{i.scheme}</TableCell><TableCell colSpan={4}>{i.value}</TableCell><TableCell>{i.source}</TableCell></TableRow>)}</TableBody>
                </Table>
              )}
              {tab === "access" && (
                <>
                  {d.file && (
                    <Table size="small"><TableBody>
                      {Object.entries({ "Access basis": d.file.access_basis, Licence: d.file.license, Version: d.file.version,
                        "Source URL": d.file.source_url, "Original filename": d.file.original_filename, SHA256: d.file.sha256,
                        Size: `${d.file.size_bytes} bytes`, Pages: d.file.page_count, Collected: new Date(d.file.downloaded_at).toLocaleString(),
                        Redistributable: d.file.redistributable ? "yes (open licence)" : "no" }).map(([k, v]) => (
                        <TableRow key={k}><TableCell sx={{ fontWeight: 600 }}>{k}</TableCell><TableCell sx={{ wordBreak: "break-all" }}>{(v as any) ?? <Missing />}</TableCell></TableRow>
                      ))}
                    </TableBody></Table>
                  )}
                  <Typography variant="subtitle2" sx={{ mt: 2 }}>Reported locations</Typography>
                  <Table size="small">
                    <TableHead><TableRow><TableCell>Source</TableCell><TableCell>Status</TableCell><TableCell>Basis</TableCell><TableCell>Version / licence</TableCell><TableCell>URL</TableCell></TableRow></TableHead>
                    <TableBody>{d.access_records.map((a: any) => (
                      <TableRow key={a.id}><TableCell>{a.source}<Typography variant="caption" display="block">{a.host_type}</Typography></TableCell>
                        <TableCell>{a.status}{a.error && <Typography variant="caption" display="block">{a.error}</Typography>}</TableCell>
                        <TableCell>{a.access_basis}</TableCell><TableCell>{a.version ?? "—"} / {a.license ?? "—"}</TableCell>
                        <TableCell sx={{ wordBreak: "break-all" }}>{a.url ?? a.landing_page_url ?? "—"}</TableCell></TableRow>
                    ))}</TableBody>
                  </Table>
                </>
              )}
              {tab === "notes" && (
                <>
                  {d.notes.map((n: any) => <Paper key={n.id} variant="outlined" sx={{ p: 1, my: 0.5 }}><Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>{n.body}</Typography>
                    <Typography variant="caption">{new Date(n.created_at).toLocaleString()}</Typography></Paper>)}
                  <TextField fullWidth multiline minRows={3} sx={{ mt: 1 }} label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button sx={{ mt: 1 }} disabled={!note.trim()} onClick={async () => {
                    try { await api.post(`${base}/notes`, { body: note }); setNote(""); load(); } catch (e) { setActionError((e as Error).message); }
                  }}>Save note</Button>
                </>
              )}
            </Box>
          </Paper>
        </Grid>
      </Grid>
    </Stack>
  );
}

function CorrectionForm({ base, onSaved }: { base: string; onSaved: () => void }) {
  const [field, setField] = useState("title");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Paper variant="outlined" sx={{ p: 1.5, mt: 2 }}>
      <Typography variant="subtitle2">Correct a field</Typography>
      <Typography variant="caption" color="text.secondary">Corrections are stored separately; provider values are kept.</Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
        <TextField select size="small" value={field} onChange={(e) => setField(e.target.value)}>
          {["title", "abstract", "venue", "publication_year", "document_type", "doi", "language"].map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
        </TextField>
        <TextField size="small" label="Corrected value" value={value} onChange={(e) => setValue(e.target.value)} fullWidth />
        <TextField size="small" label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button disabled={!value} onClick={async () => {
          try {
            await api.patch(base, { corrections: { [field]: field === "publication_year" ? Number(value) : value }, correction_reason: reason });
            setValue(""); setReason(""); onSaved();
          } catch (e) { setErr((e as Error).message); }
        }}>Save</Button>
      </Stack>
      {err && <Alert severity="error" sx={{ mt: 1 }}>{err}</Alert>}
    </Paper>
  );
}
