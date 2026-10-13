// Thin typed client for /api/v1. The token lives in sessionStorage (per-tab, cleared on close).

const BASE = "/api/v1";
const TOKEN_KEY = "rip.token";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session lasts for this page only */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  if (res.status === 401 && path !== "/auth/login") {
    setToken(null);
    window.dispatchEvent(new Event("rip:logout"));
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, msg);
  }
  if (raw) return (await res.blob()) as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b: unknown) => request<T>("PUT", p, b),
  blob: (p: string) => request<Blob>("GET", p, undefined, true),
};

// ------------------------------------------------------------------ types

export type Role = "owner" | "admin" | "editor" | "viewer";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  research_question: string | null;
  is_fixture: boolean;
  created_at: string;
  role: Role | null;
}

export interface Job {
  id: string;
  kind: string;
  status: string;
  stage: string;
  progress: number;
  result: Record<string, unknown>;
  error: string | null;
  attempts: number;
  created_at: string;
  finished_at: string | null;
  params: Record<string, unknown>;
}

export interface SearchRun {
  id: string;
  job_id: string;
  source: string;
  exact_query: string;
  request_params: Record<string, unknown>;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  pagination: { pages_fetched?: number; total_available?: number | null; cursor?: string | null };
  result_limit: number;
  retrieved_count: number;
  new_count: number;
  duplicate_count: number;
  exclusion_count: number;
  failure_count: number;
  partial_coverage: boolean;
  errors: string[];
  connector_version: string;
}

export interface Search {
  id: string;
  name: string;
  original_query: string;
  expanded_query: { text: string; version: string; basis: string } | null;
  keywords: string[];
  sources: string[];
  result_limit: number;
  pdf_mode: string;
  date_from: string | null;
  date_to: string | null;
  created_at: string;
  runs: SearchRun[];
  jobs: Job[];
}

export interface PaperRow {
  id: string;
  doi: string | null;
  title: string | null;
  authors: string[];
  author_count: number;
  venue: string | null;
  publication_year: number | null;
  access_status: string;
  processing_status: string | null;
  record_type: "collected" | "discovery";
  relevance_score: number | null;
  rank: number | null;
  coverage: number | null;
  text_basis: string | null;
  sources: string[];
  screening_status: string;
  tags: string[];
  excluded: boolean;
  is_fixture: boolean;
  has_conflicts: boolean;
}

export interface PaperPage {
  items: PaperRow[];
  total: number;
  ranking: { id: string; version: string; snapshot_at: string; query: string; weights: Record<string, number> } | null;
}

export interface ConnectorStatus {
  name: string;
  display_name: string;
  state: string;
  detail: string | null;
  documentation_url?: string;
  verified_on: string | null;
  verification_method?: string;
  authentication?: string;
  rate_limits?: string;
  pagination?: string;
  capabilities: string[];
  last_success_at?: string | null;
  last_error?: string | null;
}

export interface AnalyticsPoint {
  paper_id: string;
  title: string | null;
  doi: string | null;
  publication_year: number | null;
  relevance_score: number | null;
  lexical: number | null;
  semantic: number | null;
  embedding_pc1: number | null;
  embedding_pc2: number | null;
  embedding_pc3: number | null;
  access_status: string;
  record_type: string;
  source: string;
  is_fixture: boolean;
  [key: string]: string | number | boolean | null;
}

export interface Analytics {
  dimensions: Record<string, { label: string; unit?: string; transform: string; type: string }>;
  points: AnalyticsPoint[];
  missing_counts: Record<string, number>;
  total: number;
  excluded_hidden: number;
  ranking: { id: string; version: string; snapshot_at: string; query: string } | null;
  embedding: { provider: string; model: string; is_semantic: boolean; pca_explained_variance: number[] | null;
    pca_note: string | null };
  notes: string[];
}

/** Subscribe to job progress via SSE; falls back to polling if EventSource fails. */
export function watchJob(jobId: string, onUpdate: (j: Job) => void): () => void {
  const token = getToken();
  let closed = false;
  let timer: number | undefined;
  const poll = async () => {
    if (closed) return;
    try {
      const j = await api.get<Job>(`/jobs/${jobId}`);
      onUpdate(j);
      if (["succeeded", "failed", "partial", "cancelled"].includes(j.status)) return;
    } catch {
      /* keep polling */
    }
    timer = window.setTimeout(poll, 2000);
  };
  if (typeof EventSource === "undefined" || !token) {
    poll();
    return () => { closed = true; window.clearTimeout(timer); };
  }
  const es = new EventSource(`${BASE}/jobs/${jobId}/events?access_token=${encodeURIComponent(token)}`);
  es.addEventListener("job", (e) => onUpdate(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("end", () => es.close());
  es.onerror = () => { es.close(); if (!closed) poll(); };
  return () => { closed = true; es.close(); window.clearTimeout(timer); };
}
