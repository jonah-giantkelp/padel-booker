export type CourtType = "padel" | "tennis";
export type JobStatus = "scheduled" | "running" | "success" | "failed";
export type StopAt = "basket" | "details" | "payment";
export type JobKind = "booking" | "probe";

export interface BookingDetails {
  fullName: string;
  email: string;
  mobile: string;
  otherTel?: string;
  dob: string;
  gender: "f" | "m" | "n";
}

export interface JobResult {
  kind: "booking";
  stageReached: StopAt;
  finalUrl: string;
  court: string;
  time: string;
  price: string | null;
}

export interface ProbeResult {
  kind: "probe";
  lastClosedAt: string | null;
  openedAt: string;
  availableCount: number;
  slotCount: number;
}

export interface BookingJob {
  id: string;
  createdAt: string;
  kind: JobKind;
  venue: string;
  date: string;
  hour?: number;
  courtType?: CourtType;
  courtNumber?: number;
  details?: BookingDetails;
  stopAt?: StopAt;
  fireAt: string;
  status: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: JobResult | ProbeResult;
}

export interface AppConfig {
  venues: string[];
  bookingWindowDays: number;
  releaseTime: string;
  warmupMinutes: number;
  timezone: string;
}

export interface NewJob {
  kind: JobKind;
  venue: string;
  date: string;
  time?: string;
  courtType?: CourtType;
  courtNumber?: string;
  stopAt?: StopAt;
  details?: BookingDetails;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  config: () => request<AppConfig>("/api/config"),
  jobs: () => request<BookingJob[]>("/api/jobs"),
  createJob: (job: NewJob) =>
    request<BookingJob>("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job)
    }),
  runNow: (id: string) => request<BookingJob>(`/api/jobs/${id}/run`, { method: "POST" }),
  deleteJob: (id: string) => request<void>(`/api/jobs/${id}`, { method: "DELETE" }),
  artifacts: (id: string) => request<string[]>(`/api/jobs/${id}/artifacts`)
};
