import { useEffect, useState } from "react";
import { Link as RouterLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { AppBar, Box, Button, Toolbar, Typography } from "@mui/material";
import { api, getToken, setToken } from "./api";
import LoginPage from "./pages/LoginPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectPage from "./pages/ProjectPage";
import PaperPage from "./pages/PaperPage";
import ConnectorsPage from "./pages/ConnectorsPage";

export default function App() {
  const [authed, setAuthed] = useState<boolean>(!!getToken());
  const [me, setMe] = useState<{ email: string; display_name: string } | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    const onLogout = () => setAuthed(false);
    window.addEventListener("rip:logout", onLogout);
    return () => window.removeEventListener("rip:logout", onLogout);
  }, []);

  useEffect(() => {
    if (authed) api.get<{ email: string; display_name: string }>("/auth/me").then(setMe).catch(() => setMe(null));
  }, [authed]);

  if (!authed) return <LoginPage onLogin={() => setAuthed(true)} />;

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "#f8fafc" }}>
      <AppBar position="static" elevation={0}>
        <Toolbar variant="dense" sx={{ gap: 2 }}>
          <Typography component={RouterLink} to="/" variant="h6" sx={{ color: "inherit", textDecoration: "none" }}>
            Research Intelligence
          </Typography>
          <Button color="inherit" component={RouterLink} to="/connectors">Connectors</Button>
          <Box sx={{ flex: 1 }} />
          <Typography variant="body2">{me?.display_name}</Typography>
          <Button color="inherit" onClick={() => { setToken(null); setAuthed(false); nav("/"); }}>Sign out</Button>
        </Toolbar>
      </AppBar>
      <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 1600, mx: "auto" }}>
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/connectors" element={<ConnectorsPage />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route path="/projects/:projectId/papers/:paperId" element={<PaperPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Box>
    </Box>
  );
}
