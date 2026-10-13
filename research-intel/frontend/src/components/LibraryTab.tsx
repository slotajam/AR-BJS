import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Chip, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { DataGrid, type GridColDef, type GridSortModel } from "@mui/x-data-grid";
import { api, type PaperPage, type PaperRow } from "../api";
import { fmtScore } from "../viz";
import JobProgress from "./JobProgress";

const ACCESS_COLOR: Record<string, "success" | "warning" | "error" | "info" | "default"> = {
  collected: "success", user_uploaded: "success", permitted_available: "info", access_restricted: "warning",
  unavailable: "default", fetch_failed: "error", invalid_pdf: "error", not_checked: "default",
};

interface Props {
  projectId: string;
  canEdit: boolean;
  version: number;
  selection: string[];
  onSelection: (ids: string[]) => void;
}

export default function LibraryTab({ projectId, canEdit, version, selection, onSelection }: Props) {
  const nav = useNavigate();
  const [data, setData] = useState<PaperPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({ page: 0, pageSize: 50 });
  const [sort, setSort] = useState<GridSortModel>([{ field: "relevance_score", sort: "desc" }]);
  const [q, setQ] = useState("");
  const [recordType, setRecordType] = useState("all");
  const [access, setAccess] = useState("");
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [jobs, setJobs] = useState<string[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams({
      page: String(pagination.page + 1), page_size: String(pagination.pageSize),
      sort: sort[0]?.field ?? "relevance_score", order: sort[0]?.sort ?? "desc", record_type: recordType,
      include_excluded: String(includeExcluded),
    });
    if (q) params.set("q", q);
    if (access) params.set("access_status", access);
    const t = setTimeout(() => {
      api.get<PaperPage>(`/projects/${projectId}/papers?${params}`).then(setData).catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [projectId, pagination, sort, q, recordType, access, includeExcluded, version, reload]);

  const columns = useMemo<GridColDef<PaperRow>[]>(() => [
    { field: "record_type", headerName: "Record", width: 105, sortable: false,
      renderCell: (p) => <Chip size="small" variant={p.value === "collected" ? "filled" : "outlined"}
                               color={p.value === "collected" ? "success" : "default"} label={p.value} /> },
    { field: "access_status", headerName: "Access", width: 160,
      renderCell: (p) => <Chip size="small" color={ACCESS_COLOR[p.value] ?? "default"} label={p.value} /> },
    { field: "processing_status", headerName: "Processing", width: 110, valueFormatter: (v) => v ?? "—" },
    { field: "relevance_score", headerName: "Score", width: 85, type: "number", valueFormatter: (v) => fmtScore(v) },
    { field: "coverage", headerName: "Coverage", width: 90, sortable: false,
      renderCell: (p) => <Tooltip title={`Text basis: ${p.row.text_basis ?? "—"}`}><span>{fmtScore(p.value)}</span></Tooltip> },
    { field: "title", headerName: "Title", flex: 2, minWidth: 260,
      renderCell: (p) => <span title={p.value ?? ""}>{p.row.is_fixture && <Chip size="small" color="warning" label="FIXTURE" sx={{ mr: 0.5 }} />}
        {p.value ?? <i>(no title — {"missing"})</i>}</span> },
    { field: "authors", headerName: "Authors", flex: 1, minWidth: 150, sortable: false,
      valueGetter: (_, row) => row.authors.join(", ") + (row.author_count > row.authors.length ? " et al." : "") || "—" },
    { field: "venue", headerName: "Venue", flex: 1, minWidth: 140, valueFormatter: (v) => v ?? "—" },
    { field: "publication_year", headerName: "Year", width: 70, valueFormatter: (v) => v ?? "—" },
    { field: "doi", headerName: "DOI", width: 170, valueFormatter: (v) => v ?? "—" },
    { field: "sources", headerName: "Sources", width: 140, sortable: false, valueGetter: (_, row) => row.sources.join(", ") },
    { field: "screening_status", headerName: "Screening", width: 105, sortable: false },
    { field: "tags", headerName: "Tags", width: 120, sortable: false, valueGetter: (_, row) => row.tags.join(", ") },
  ], []);

  const collectSelected = async () => {
    const started: string[] = [];
    for (const id of selection) {
      try {
        const j = await api.post<{ id: string }>(`/projects/${projectId}/papers/${id}/collect`, { idempotency_key: crypto.randomUUID() });
        started.push(j.id);
      } catch (e) { setError((e as Error).message); }
    }
    setJobs(started);
  };

  return (
    <Stack spacing={1.5}>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }}>
          <TextField size="small" label="Search title / DOI / venue" value={q} onChange={(e) => setQ(e.target.value)} />
          <TextField size="small" select label="Record type" value={recordType} onChange={(e) => setRecordType(e.target.value)} sx={{ minWidth: 150 }}>
            <MenuItem value="all">All</MenuItem><MenuItem value="collected">Collected corpus</MenuItem>
            <MenuItem value="discovery">Discovery only</MenuItem>
          </TextField>
          <TextField size="small" select label="Access" value={access} onChange={(e) => setAccess(e.target.value)} sx={{ minWidth: 170 }}>
            <MenuItem value="">Any</MenuItem>
            {Object.keys(ACCESS_COLOR).map((a) => <MenuItem key={a} value={a}>{a}</MenuItem>)}
          </TextField>
          <Button size="small" variant={includeExcluded ? "contained" : "outlined"} onClick={() => setIncludeExcluded(!includeExcluded)}>
            {includeExcluded ? "Showing excluded" : "Excluded hidden"}
          </Button>
          {canEdit && <Button size="small" variant="outlined" disabled={!selection.length} onClick={collectSelected}>
            Collect permitted PDFs ({selection.length})
          </Button>}
          <Typography variant="caption" color="text.secondary">
            {data?.ranking ? `Scores: ${data.ranking.version} snapshot ${new Date(data.ranking.snapshot_at).toLocaleString()}` : "No ranking yet"}
          </Typography>
        </Stack>
      </Paper>
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      {jobs.map((j) => <JobProgress key={j} jobId={j} canEdit={canEdit} onDone={() => setReload((r) => r + 1)} />)}
      <Paper variant="outlined" sx={{ height: 640 }}>
        <DataGrid
          rows={data?.items ?? []}
          columns={columns}
          rowCount={data?.total ?? 0}
          loading={!data}
          paginationMode="server"
          sortingMode="server"
          paginationModel={pagination}
          onPaginationModelChange={setPagination}
          sortModel={sort}
          onSortModelChange={(m) => setSort(m.length ? m : [{ field: "relevance_score", sort: "desc" }])}
          pageSizeOptions={[25, 50, 100, 250]}
          checkboxSelection
          keepNonExistentRowsSelected
          rowSelectionModel={selection}
          onRowSelectionModelChange={(m) => onSelection(m as string[])}
          onRowDoubleClick={(p) => nav(`/projects/${projectId}/papers/${p.id}`)}
          getRowClassName={(p) => (p.row.excluded ? "excluded" : "")}
          density="compact"
          disableColumnFilter
          sx={{ "& .excluded": { opacity: 0.5 } }}
        />
      </Paper>
      <Typography variant="caption" color="text.secondary">
        Double-click a row to open the paper. "—" marks values no source supplied. Discovery records are metadata only.
      </Typography>
    </Stack>
  );
}
