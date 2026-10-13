import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert, Button, Card, CardActionArea, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid,
  Stack, TextField, Typography,
} from "@mui/material";
import { api, type Project } from "../api";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", research_question: "", description: "" });
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<Project[]>("/projects").then(setProjects).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      await api.post("/projects", form);
      setOpen(false);
      setForm({ name: "", research_question: "", description: "" });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5">Projects</Typography>
        <Button variant="contained" onClick={() => setOpen(true)}>New project</Button>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {projects && projects.length === 0 && <Typography color="text.secondary">No projects yet.</Typography>}
      <Grid container spacing={2}>
        {projects?.map((p) => (
          <Grid item xs={12} md={6} lg={4} key={p.id}>
            <Card variant="outlined">
              <CardActionArea component={RouterLink} to={`/projects/${p.id}`}>
                <CardContent>
                  <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                    <Chip size="small" label={p.role} />
                    {p.is_fixture && <Chip size="small" color="warning" label="FIXTURE / demo data" />}
                  </Stack>
                  <Typography variant="h6">{p.name}</Typography>
                  <Typography variant="body2" color="text.secondary">{p.research_question ?? "No research question"}</Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New project</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <TextField label="Research question" multiline minRows={2} value={form.research_question}
                       onChange={(e) => setForm({ ...form, research_question: e.target.value })}
                       helperText="Used as the default ranking query." />
            <TextField label="Description" multiline minRows={2} value={form.description}
                       onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={create} disabled={!form.name}>Create</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
