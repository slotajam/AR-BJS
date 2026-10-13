import { Suspense, lazy, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Alert, Box, Chip, LinearProgress, Paper, Stack, Tab, Tabs, Typography } from "@mui/material";
import { api, type Project } from "../api";
import SearchesTab from "../components/SearchesTab";
import LibraryTab from "../components/LibraryTab";
import AddPapersTab from "../components/AddPapersTab";
import RankExportTab from "../components/RankExportTab";
import MembersTab from "../components/MembersTab";

const VisualizeTab = lazy(() => import("../components/VisualizeTab")); // Plotly is large; load on demand

export default function ProjectPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState(() => {
    try { return sessionStorage.getItem("rip.tab") ?? "library"; } catch { return "library"; }
  });
  const [selection, setSelection] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // bump to refresh data after jobs finish

  useEffect(() => {
    api.get<Project>(`/projects/${projectId}`).then(setProject).catch((e) => setError(e.message));
  }, [projectId]);

  const changeTab = (v: string) => {
    setTab(v);
    try { sessionStorage.setItem("rip.tab", v); } catch { /* ignore */ }
  };

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!project) return null;
  const canEdit = project.role !== "viewer";
  const refresh = () => setVersion((v) => v + 1);

  return (
    <Stack spacing={2}>
      <Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h5">{project.name}</Typography>
          <Chip size="small" label={project.role} />
          {project.is_fixture && <Chip size="small" color="warning" label="FIXTURE / demo data — not live results" />}
        </Stack>
        <Typography color="text.secondary">{project.research_question}</Typography>
      </Box>
      <Paper variant="outlined">
        <Tabs value={tab} onChange={(_, v) => changeTab(v)} variant="scrollable" scrollButtons="auto">
          <Tab value="library" label="Library" />
          <Tab value="visualize" label="Visualize" />
          <Tab value="searches" label="Searches" />
          <Tab value="add" label="Import / upload" />
          <Tab value="rank" label="Rank & export" />
          <Tab value="members" label="Members & audit" />
        </Tabs>
      </Paper>
      {tab === "library" && <LibraryTab projectId={project.id} canEdit={canEdit} version={version}
                                        selection={selection} onSelection={setSelection} />}
      {tab === "visualize" && (
        <Suspense fallback={<LinearProgress />}>
          <VisualizeTab projectId={project.id} version={version} selection={selection} onSelection={setSelection} />
        </Suspense>
      )}
      {tab === "searches" && <SearchesTab projectId={project.id} canEdit={canEdit} onDone={refresh} />}
      {tab === "add" && <AddPapersTab projectId={project.id} canEdit={canEdit} onDone={refresh} />}
      {tab === "rank" && <RankExportTab project={project} canEdit={canEdit} selection={selection} onDone={refresh} />}
      {tab === "members" && <MembersTab project={project} />}
    </Stack>
  );
}
