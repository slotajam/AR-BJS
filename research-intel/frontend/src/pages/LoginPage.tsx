import { useState } from "react";
import { Alert, Box, Button, Paper, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { api, setToken } from "../api";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") await api.post("/auth/register", { email, password, display_name: name });
      const t = await api.post<{ access_token: string }>("/auth/login", { email, password });
      setToken(t.access_token);
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", bgcolor: "#f1f5f9", p: 2 }}>
      <Paper sx={{ p: 4, width: "100%", maxWidth: 420 }} component="form" onSubmit={submit}>
        <Typography variant="h5" gutterBottom>Research Intelligence</Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Traceable, rights-aware literature discovery.
        </Typography>
        <Tabs value={mode} onChange={(_, v) => setMode(v)} sx={{ mb: 2 }}>
          <Tab value="login" label="Sign in" />
          <Tab value="register" label="Create account" />
        </Tabs>
        <Stack spacing={2}>
          {mode === "register" && (
            <TextField label="Display name" value={name} onChange={(e) => setName(e.target.value)} required />
          )}
          <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                     autoComplete="username" />
          <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                     required autoComplete={mode === "login" ? "current-password" : "new-password"}
                     helperText={mode === "register" ? "At least 10 characters" : undefined} />
          {error && <Alert severity="error">{error}</Alert>}
          <Button type="submit" variant="contained" disabled={busy}>
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
