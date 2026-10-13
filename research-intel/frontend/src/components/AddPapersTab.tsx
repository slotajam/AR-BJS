import { useState } from "react";
import {
  Alert, Button, Checkbox, FormControlLabel, Grid, MenuItem, Paper, Stack, TextField, Typography,
} from "@mui/material";
import { api } from "../api";
import JobProgress from "./JobProgress";

const BASES = {
  user_upload_own_work: "I am an author / rights holder of this PDF",
  user_upload_open_license: "The PDF is published under an open licence (give licence below)",
  user_upload_licensed_access: "I obtained it through access licensed to me for private research (not redistributable)",
};

export default function AddPapersTab({ projectId, canEdit, onDone }: { projectId: string; canEdit: boolean;
                                                                        onDone: () => void }) {
  const [fmt, setFmt] = useState("doi");
  const [content, setContent] = useState("");
  const [jobs, setJobs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [basis, setBasis] = useState("user_upload_own_work");
  const [attest, setAttest] = useState(false);
  const [meta, setMeta] = useState({ title: "", doi: "", license: "", version: "" });
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  if (!canEdit) return <Alert severity="info">Viewers cannot import or upload.</Alert>;

  const runImport = async () => {
    setError(null);
    try {
      const j = await api.post<{ id: string }>(`/projects/${projectId}/imports`, { format: fmt, content,
        idempotency_key: crypto.randomUUID() });
      setJobs((x) => [j.id, ...x]);
    } catch (e) { setError((e as Error).message); }
  };

  const loadFile = (f: File | undefined) => f?.text().then(setContent);

  const upload = async () => {
    if (!file) return;
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("access_basis", basis);
    fd.append("rights_attested", String(attest));
    Object.entries(meta).forEach(([k, v]) => v && fd.append(k, v));
    try {
      const r = await api.post<{ paper_id: string; duplicate: boolean; job_id: string | null; sha256?: string }>(
        `/projects/${projectId}/uploads`, fd);
      setUploadMsg(r.duplicate ? `Duplicate of an existing file (matched by checksum) — paper ${r.paper_id}`
        : `Stored (sha256 ${r.sha256?.slice(0, 12)}…); processing started.`);
      if (r.job_id) setJobs((x) => [r.job_id!, ...x]);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>Import records</Typography>
          <Stack spacing={1.5}>
            <TextField select size="small" label="Format" value={fmt} onChange={(e) => setFmt(e.target.value)}>
              <MenuItem value="doi">DOI list (looked up via OpenAlex/Crossref)</MenuItem>
              <MenuItem value="bibtex">BibTeX</MenuItem><MenuItem value="ris">RIS</MenuItem>
              <MenuItem value="csv">CSV (doi/title/authors/year/journal columns)</MenuItem>
            </TextField>
            <Button component="label" variant="outlined" size="small">Load file…
              <input hidden type="file" accept=".bib,.ris,.csv,.txt" onChange={(e) => loadFile(e.target.files?.[0])} />
            </Button>
            <TextField multiline minRows={8} maxRows={20} value={content} onChange={(e) => setContent(e.target.value)}
                       placeholder={fmt === "doi" ? "10.1234/abcd\nhttps://doi.org/10.5678/efgh" : "Paste file contents"} />
            <Button variant="contained" disabled={!content.trim()} onClick={runImport}>Import</Button>
            <Typography variant="caption" color="text.secondary">
              Imported records are deduplicated by DOI, provider ID, then conservative title/author/year; ambiguous
              matches are kept separate for manual review.
            </Typography>
          </Stack>
        </Paper>
      </Grid>
      <Grid item xs={12} md={6}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>Upload a PDF</Typography>
          <Stack spacing={1.5}>
            <Button component="label" variant="outlined" size="small">{file ? file.name : "Choose PDF…"}
              <input hidden type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Button>
            <TextField select size="small" label="Access basis" value={basis} onChange={(e) => setBasis(e.target.value)}>
              {Object.entries(BASES).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
            <Stack direction="row" spacing={1}>
              <TextField size="small" label="Title" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} fullWidth />
              <TextField size="small" label="DOI" value={meta.doi} onChange={(e) => setMeta({ ...meta, doi: e.target.value })} fullWidth />
            </Stack>
            <Stack direction="row" spacing={1}>
              <TextField size="small" label="Licence (e.g. CC-BY-4.0)" value={meta.license} onChange={(e) => setMeta({ ...meta, license: e.target.value })} fullWidth />
              <TextField size="small" select label="Version" value={meta.version} onChange={(e) => setMeta({ ...meta, version: e.target.value })} fullWidth>
                <MenuItem value="">Unknown</MenuItem><MenuItem value="publishedVersion">Published</MenuItem>
                <MenuItem value="acceptedVersion">Accepted manuscript</MenuItem><MenuItem value="submittedVersion">Preprint</MenuItem>
              </TextField>
            </Stack>
            <FormControlLabel control={<Checkbox checked={attest} onChange={(e) => setAttest(e.target.checked)} />}
                              label="I confirm I have the right to store and analyse this PDF on the basis selected." />
            <Button variant="contained" disabled={!file || !attest} onClick={upload}>Upload</Button>
            {uploadMsg && <Alert severity="info">{uploadMsg}</Alert>}
          </Stack>
        </Paper>
      </Grid>
      <Grid item xs={12}>
        {error && <Alert severity="error">{error}</Alert>}
        <Stack spacing={1}>{jobs.map((j) => <JobProgress key={j} jobId={j} canEdit onDone={onDone} />)}</Stack>
      </Grid>
    </Grid>
  );
}
