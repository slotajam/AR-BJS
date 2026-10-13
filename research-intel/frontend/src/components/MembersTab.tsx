import { useEffect, useState } from "react";
import {
  Alert, Button, Grid, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import { api, type Project } from "../api";

interface Member { user_id: string; email: string; display_name: string; role: string }
interface AuditRow { id: string; action: string; user_id: string | null; entity_type: string; created_at: string;
  details: Record<string, unknown> }

export default function MembersTab({ project }: { project: Project }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [error, setError] = useState<string | null>(null);
  const isAdmin = project.role === "owner" || project.role === "admin";

  const load = () => {
    api.get<Member[]>(`/projects/${project.id}/members`).then(setMembers).catch((e) => setError(e.message));
    if (isAdmin) api.get<AuditRow[]>(`/projects/${project.id}/audit`).then(setAudit).catch(() => setAudit(null));
  };
  useEffect(load, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    try {
      await api.put(`/projects/${project.id}/members`, { email, role });
      setEmail("");
      load();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={5}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6">Members</Typography>
          <Table size="small">
            <TableBody>
              {members.map((m) => <TableRow key={m.user_id}><TableCell>{m.display_name}</TableCell><TableCell>{m.email}</TableCell><TableCell>{m.role}</TableCell></TableRow>)}
            </TableBody>
          </Table>
          {isAdmin && (
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <TextField size="small" label="User email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <TextField size="small" select label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
                {["viewer", "editor", "admin", ...(project.role === "owner" ? ["owner"] : [])].map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
              </TextField>
              <Button variant="outlined" onClick={save} disabled={!email}>Add / update</Button>
            </Stack>
          )}
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
            viewer: read & export · editor: search, import, upload, collect, rank, annotate · admin: + members · owner: + owners
          </Typography>
        </Paper>
      </Grid>
      <Grid item xs={12} md={7}>
        <Paper variant="outlined" sx={{ p: 2, maxHeight: 600, overflow: "auto" }}>
          <Typography variant="h6">Audit log</Typography>
          {!isAdmin && <Typography color="text.secondary">Visible to admins and owners.</Typography>}
          {audit && (
            <Table size="small">
              <TableHead><TableRow><TableCell>When</TableCell><TableCell>Action</TableCell><TableCell>User</TableCell><TableCell>Details</TableCell></TableRow></TableHead>
              <TableBody>
                {audit.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{new Date(a.created_at).toLocaleString()}</TableCell><TableCell>{a.action}</TableCell>
                    <TableCell><code>{a.user_id?.slice(0, 8)}</code></TableCell>
                    <TableCell><Typography variant="caption">{JSON.stringify(a.details).slice(0, 160)}</Typography></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
      </Grid>
    </Grid>
  );
}
