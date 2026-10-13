import { useEffect, useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import { api, watchJob, type Job } from "../api";

const DONE = ["succeeded", "failed", "partial", "cancelled"];

export default function JobProgress({ jobId, onDone, canEdit }: { jobId: string; onDone?: (j: Job) => void;
                                                                  canEdit: boolean }) {
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => watchJob(jobId, (j) => {
    setJob(j);
    if (DONE.includes(j.status)) onDone?.(j);
  }), [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!job) return <LinearProgress />;
  const severity = job.status === "succeeded" ? "success" : job.status === "partial" ? "warning"
    : job.status === "failed" ? "error" : "info";
  return (
    <Alert severity={severity} sx={{ alignItems: "center" }}
           action={canEdit && (
             <Stack direction="row" spacing={1}>
               {!DONE.includes(job.status) && <Button size="small" onClick={() => api.post(`/jobs/${job.id}/cancel`)}>Cancel</Button>}
               {["failed", "partial", "cancelled"].includes(job.status) &&
                 <Button size="small" onClick={() => api.post<Job>(`/jobs/${job.id}/retry`).then(setJob)}>Retry</Button>}
             </Stack>
           )}>
      <Typography variant="body2">
        {job.kind} job <code>{job.id.slice(0, 8)}</code>: <b>{job.status}</b> · stage {job.stage} · attempt {job.attempts}
      </Typography>
      {!DONE.includes(job.status) && <Box sx={{ mt: 1, width: 300 }}><LinearProgress variant="determinate" value={job.progress * 100} /></Box>}
      {job.error && <Typography variant="caption" component="pre" sx={{ whiteSpace: "pre-wrap" }}>{job.error.split("\n")[0]}</Typography>}
      {DONE.includes(job.status) && Object.keys(job.result ?? {}).length > 0 &&
        <Typography variant="caption" component="pre" sx={{ whiteSpace: "pre-wrap", m: 0 }}>
          {JSON.stringify(job.result, null, 0).slice(0, 400)}
        </Typography>}
    </Alert>
  );
}
