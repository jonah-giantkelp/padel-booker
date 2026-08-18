import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, AppConfig, BookingJob, CourtType, JobKind, NewJob, StopAt } from "./api";

const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 7am–9pm
const hourLabel = (h: number) => (h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`);
const venueLabel = (slug: string) =>
  slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function minDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmt(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

const STAGE_LABEL: Record<StopAt, string> = {
  basket: "Add to basket only",
  details: "Basket + fill my details",
  checkout: "Basket + details + proceed to checkout"
};

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [jobs, setJobs] = useState<BookingJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    kind: "booking" as JobKind,
    venue: "bethnal-green-gardens",
    date: "",
    hour: "19",
    courtType: "padel" as CourtType,
    courtNumber: "",
    stopAt: "checkout" as StopAt,
    fullName: "",
    email: "",
    mobile: "",
    otherTel: "",
    dob: "",
    gender: "" as "" | "f" | "m" | "n"
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const refresh = useCallback(() => {
    api.jobs().then(setJobs).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setError(e.message));
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const job: NewJob =
        form.kind === "probe"
          ? { kind: "probe", venue: form.venue, date: form.date }
          : {
              kind: "booking",
              venue: form.venue,
              date: form.date,
              time: form.hour,
              courtType: form.courtType,
              courtNumber: form.courtNumber || undefined,
              stopAt: form.stopAt,
              details: {
                fullName: form.fullName,
                email: form.email,
                mobile: form.mobile,
                otherTel: form.otherTel || undefined,
                dob: form.dob || undefined,
                gender: form.gender || undefined
              }
            };
      const created = await api.createJob(job);
      setNotice(
        form.kind === "probe"
          ? `Probe queued — starts ${fmt(created.fireAt)} and polls until ${form.date} opens, recording when it flips.`
          : `Job queued — fires ${fmt(created.fireAt)} (${config?.warmupMinutes ?? 2}min before the ` +
              `${config?.releaseTime ?? "00:00"} release, which is still TBC)`
      );
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main>
      <header>
        <h1>🎾 Padel Booker</h1>
        <p>
          Courts at Tennis Tower Hamlets open {config?.bookingWindowDays ?? 7} days ahead. Queue a
          booking and it fires the moment the day is released
          {config ? ` (assumed ${config.releaseTime} ${config.timezone} — TBC)` : ""}.
        </p>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <form onSubmit={submit}>
        <section>
          <h2>Job type</h2>
          <div className="kind-toggle">
            <label className={form.kind === "booking" ? "selected" : ""}>
              <input
                type="radio"
                name="kind"
                checked={form.kind === "booking"}
                onChange={() => set({ kind: "booking" })}
              />
              Book a court
            </label>
            <label className={form.kind === "probe" ? "selected" : ""}>
              <input
                type="radio"
                name="kind"
                checked={form.kind === "probe"}
                onChange={() => set({ kind: "probe" })}
              />
              Find the release time
            </label>
          </div>
          {form.kind === "probe" && (
            <p className="hint">
              Pick a date {(config?.bookingWindowDays ?? 7) + 1}+ days out. The probe starts just
              before the assumed release, reloads the page every few minutes, and records the window
              in which the day became bookable — then set RELEASE_TIME accordingly.
            </p>
          )}
        </section>

        <section>
          <h2>{form.kind === "probe" ? "What to watch" : "Court"}</h2>
          <div className="grid">
            <label>
              Venue
              <select value={form.venue} onChange={(e) => set({ venue: e.target.value })}>
                {(config?.venues ?? [form.venue]).map((v) => (
                  <option key={v} value={v}>
                    {venueLabel(v)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input
                type="date"
                required
                min={minDate()}
                value={form.date}
                onChange={(e) => set({ date: e.target.value })}
              />
            </label>
            {form.kind === "booking" && (
            <>
            <label>
              Start time
              <select value={form.hour} onChange={(e) => set({ hour: e.target.value })}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Court type
              <select
                value={form.courtType}
                onChange={(e) => set({ courtType: e.target.value as CourtType })}
              >
                <option value="padel">Padel</option>
                <option value="tennis">Tennis</option>
              </select>
            </label>
            <label>
              Court № <span className="hint">(optional — else first available)</span>
              <input
                type="number"
                min="1"
                placeholder="any"
                value={form.courtNumber}
                onChange={(e) => set({ courtNumber: e.target.value })}
              />
            </label>
            <label>
              How far to go
              <select value={form.stopAt} onChange={(e) => set({ stopAt: e.target.value as StopAt })}>
                {(Object.keys(STAGE_LABEL) as StopAt[]).map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            </>
            )}
          </div>
        </section>

        {form.kind === "booking" && (
        <section>
          <h2>Your details</h2>
          <p className="hint">
            What the site's checkout asks for. Payment is never automated — you finish it from the
            confirmation the site sends.
          </p>
          <div className="grid">
            <label>
              Full name
              <input
                required
                value={form.fullName}
                onChange={(e) => set({ fullName: e.target.value })}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) => set({ email: e.target.value })}
              />
            </label>
            <label>
              Mobile
              <input
                type="tel"
                required
                value={form.mobile}
                onChange={(e) => set({ mobile: e.target.value })}
              />
            </label>
            <label>
              Other phone <span className="hint">(optional)</span>
              <input
                type="tel"
                value={form.otherTel}
                onChange={(e) => set({ otherTel: e.target.value })}
              />
            </label>
            <label>
              Date of birth <span className="hint">(optional)</span>
              <input type="date" value={form.dob} onChange={(e) => set({ dob: e.target.value })} />
            </label>
            <label>
              Gender <span className="hint">(optional)</span>
              <select
                value={form.gender}
                onChange={(e) => set({ gender: e.target.value as typeof form.gender })}
              >
                <option value="">Prefer not to say</option>
                <option value="f">Female</option>
                <option value="m">Male</option>
              </select>
            </label>
          </div>
        </section>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Queuing…" : form.kind === "probe" ? "Queue probe" : "Queue booking"}
        </button>
      </form>

      <section>
        <h2>Queued &amp; past jobs</h2>
        {jobs.length === 0 ? (
          <p className="hint">Nothing queued yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Booking</th>
                <th>Fires</th>
                <th>Status</th>
                <th>Outcome</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} onRun={() => act(() => api.runNow(j.id))} onDelete={() => act(() => api.deleteJob(j.id))} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function JobRow({ job, onRun, onDelete }: { job: BookingJob; onRun: () => void; onDelete: () => void }) {
  const [artifacts, setArtifacts] = useState<string[]>([]);
  useEffect(() => {
    if (job.status === "success" || job.status === "failed") {
      api.artifacts(job.id).then(setArtifacts).catch(() => {});
    }
  }, [job.id, job.status]);

  return (
    <tr>
      <td>
        <strong>
          {job.kind === "probe"
            ? `release probe · ${job.date}`
            : `${job.courtType}${job.courtNumber ? ` ${job.courtNumber}` : ""} · ${hourLabel(job.hour ?? 0)} · ${job.date}`}
        </strong>
        <div className="hint">
          {venueLabel(job.venue)}
          {job.kind === "booking" ? ` · to ${job.stopAt}` : ""}
        </div>
      </td>
      <td>{fmt(job.fireAt)}</td>
      <td>
        <span className={`status ${job.status}`}>{job.status}</span>
      </td>
      <td className="outcome">
        {job.result?.kind === "booking" && (
          <>
            {job.result.court} {job.result.time} {job.result.price ?? ""} — reached{" "}
            {job.result.stageReached}
          </>
        )}
        {job.result?.kind === "probe" && (
          <>
            {job.result.lastClosedAt
              ? `Released between ${fmt(job.result.lastClosedAt)} and ${fmt(job.result.openedAt)}`
              : `Already open when first checked (${fmt(job.result.openedAt)})`}{" "}
            — {job.result.availableCount}/{job.result.slotCount} slots available
          </>
        )}
        {job.error && <span className="error-text">{job.error}</span>}
        {artifacts.length > 0 && (
          <div className="artifacts">
            {artifacts
              .filter((f) => f.endsWith(".png"))
              .map((f) => (
                <a key={f} href={`/api/jobs/${job.id}/artifacts/${f}`} target="_blank" rel="noreferrer">
                  {f.replace(".png", "")}
                </a>
              ))}
          </div>
        )}
      </td>
      <td className="actions">
        {job.status !== "running" && (
          <>
            <button type="button" onClick={onRun} title="Fire on the next scheduler tick">
              {job.status === "failed" ? "Retry now" : "Run now"}
            </button>
            <button type="button" className="danger" onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
