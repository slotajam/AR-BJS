import { useEffect, useState } from "react";
import {
  Alert, Chip, Link, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography,
} from "@mui/material";
import { api, type ConnectorStatus } from "../api";

const COLOR: Record<string, "success" | "warning" | "error" | "default"> = {
  available: "success", rate_limited: "warning", error: "error", unconfigured: "default", disabled: "default",
};

export default function ConnectorsPage() {
  const [rows, setRows] = useState<ConnectorStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<ConnectorStatus[]>("/connectors/status").then(setRows).catch((e) => setError(e.message)); }, []);
  return (
    <Stack spacing={2}>
      <Typography variant="h5">Connector status</Typography>
      <Alert severity="info">
        "Available" means configured and not currently failing. "Verified on" is only set after a live verification
        run (<code>python -m app.cli verify-connectors</code>); it is never inferred.
      </Alert>
      {error && <Alert severity="error">{error}</Alert>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Connector</TableCell><TableCell>State</TableCell><TableCell>Capabilities</TableCell>
              <TableCell>Auth</TableCell><TableCell>Rate limits</TableCell><TableCell>Pagination</TableCell>
              <TableCell>Verified on</TableCell><TableCell>Last error</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.name}>
                <TableCell>
                  {c.documentation_url ? <Link href={c.documentation_url} target="_blank" rel="noreferrer">{c.display_name}</Link>
                    : c.display_name}
                </TableCell>
                <TableCell><Chip size="small" color={COLOR[c.state] ?? "default"} label={c.state} />
                  {c.detail && <Typography variant="caption" display="block">{c.detail}</Typography>}</TableCell>
                <TableCell>{c.capabilities.join(", ")}</TableCell>
                <TableCell>{c.authentication}</TableCell>
                <TableCell>{c.rate_limits}</TableCell>
                <TableCell>{c.pagination}</TableCell>
                <TableCell>{c.verified_on ?? "not live-verified"}</TableCell>
                <TableCell>{c.last_error ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
