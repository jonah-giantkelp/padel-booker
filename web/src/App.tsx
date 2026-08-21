import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, AppConfig, AvailabilityPreview, BookingJob, CourtType, JobKind, NewJob, StopAt } from "./api";

const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);
const hourLabel = (h: number) => (h < 12 ? `${h}:00` : h === 12 ? "12:00" : `${h - 12}:00`);
const venueLabel = (slug: string) => slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const isoDate = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const fmt = (iso?: string) => iso ? new Date(iso).toLocaleString("en-GB", {
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
}) : "—";

function Mark() {
  return <span className="mark" aria-hidden="true"><i /><i /><i /></span>;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [jobs, setJobs] = useState<BookingJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityPreview | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [form, setForm] = useState({
    kind: "booking" as JobKind,
    venue: "bethnal-green-gardens",
    date: isoDate(new Date()),
    hour: "19",
    courtType: "padel" as CourtType,
    courtNumber: "",
    stopAt: "payment" as StopAt,
    fullName: "",
    email: "",
    mobile: "",
    otherTel: "",
    dob: "",
    gender: "" as "" | "f" | "m" | "n"
  });
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const days = useMemo(() => Array.from({ length: (config?.bookingWindowDays ?? 7) + 1 }, (_, i) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + i);
    return date;
  }), [config?.bookingWindowDays]);

  const refresh = useCallback(() => api.jobs().then(setJobs).catch((e) => setError(e.message)), []);
  useEffect(() => {
    api.config().then(setConfig).catch((e) => setError(e.message));
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setAvailabilityLoading(true);
    setAvailability(null);
    api.availability(form.date, form.venue)
      .then((result) => { if (!cancelled) setAvailability(result); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setAvailabilityLoading(false); });
    return () => { cancelled = true; };
  }, [form.date, form.venue]);

  const availableHours = useMemo(() => new Set(
    availability?.slots.filter((slot) => slot.type === form.courtType).map((slot) => slot.hour) || []
  ), [availability, form.courtType]);
  useEffect(() => {
    if (!availability?.released || availableHours.has(Number(form.hour))) return;
    const first = [...availableHours].sort((a, b) => a - b)[0];
    if (first !== undefined) set({ hour: String(first) });
  }, [availability, availableHours, form.hour]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (form.kind === "booking" && (!form.fullName || !form.email || !form.mobile || !form.dob || !form.gender)) {
      setShowDetails(true);
      setError("Add your player details to finish setting up this booking.");
      return;
    }
    setSubmitting(true);
    try {
      const payload: NewJob = form.kind === "probe"
        ? { kind: "probe", venue: form.venue, date: form.date }
        : {
            kind: "booking", venue: form.venue, date: form.date, time: form.hour,
            courtType: form.courtType, courtNumber: form.courtNumber || undefined,
            stopAt: form.stopAt,
            details: {
              fullName: form.fullName, email: form.email, mobile: form.mobile,
              otherTel: form.otherTel || undefined, dob: form.dob,
              gender: form.gender as "f" | "m" | "n"
            }
          };
      const created = await api.createJob(payload);
      setNotice(form.kind === "probe"
        ? `Release watch set for ${form.date}.`
        : `You're set. We'll start at ${fmt(created.fireAt)} and take it to payment.`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  const selectedDay = days.find((day) => isoDate(day) === form.date) || days[0];

  return (
    <div className="app-shell">
      <nav className="topbar">
        <a className="brand" href="#top"><Mark /><span>COURT/01</span></a>
        <div className="nav-meta"><span>London courts</span><b>{jobs.filter((j) => j.status === "scheduled").length} upcoming</b><button onClick={() => api.logout().then(() => location.reload())}>Sign out</button></div>
      </nav>

      <header className="hero" id="top">
        <img src="/images/padel-hero.jpg" alt="Padel players on an outdoor London court" />
        <div className="hero-shade" />
        <div className="hero-copy">
          <span className="eyebrow">Play more · queue less</span>
          <h1>Your next court,<br /><em>already handled.</em></h1>
          <p>Choose the moment. We watch the release and get everything ready through to payment.</p>
          <a className="hero-link" href="#booking">Find a court <span>↘</span></a>
        </div>
        <div className="hero-index"><span>51.5272° N</span><span>East London</span></div>
      </header>

      <main id="booking">
        {error && <div className="toast error">{error}<button onClick={() => setError(null)}>×</button></div>}
        {notice && <div className="toast success">{notice}<button onClick={() => setNotice(null)}>×</button></div>}

        <form className="booking-studio" onSubmit={submit}>
          <div className="section-heading">
            <span className="step">01</span>
            <div><span className="eyebrow dark">Build your session</span><h2>When are we playing?</h2></div>
            <div className="mode-switch" aria-label="Job type">
              <button type="button" className={form.kind === "booking" ? "active" : ""} onClick={() => set({ kind: "booking" })}>Book</button>
              <button type="button" className={form.kind === "probe" ? "active" : ""} onClick={() => set({ kind: "probe" })}>Watch release</button>
            </div>
          </div>

          <div className="venue-line">
            <span className="field-number">A</span>
            <label><span>Venue</span><select value={form.venue} onChange={(e) => set({ venue: e.target.value })}>
              {(config?.venues ?? [form.venue]).map((venue) => <option key={venue} value={venue}>{venueLabel(venue)}</option>)}
            </select></label>
            {form.kind === "booking" && <div className="sport-pills">
              <button type="button" className={form.courtType === "padel" ? "active" : ""} onClick={() => set({ courtType: "padel" })}>Padel</button>
              <button type="button" className={form.courtType === "tennis" ? "active" : ""} onClick={() => set({ courtType: "tennis" })}>Tennis</button>
            </div>}
          </div>

          <div className="calendar-block">
            <div className="calendar-label"><span className="field-number">B</span><span>Select a day</span><strong>{selectedDay.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</strong></div>
            <div className="week-strip">
              {days.map((day, index) => {
                const value = isoDate(day);
                return <button type="button" key={value} className={form.date === value ? "selected" : ""} onClick={() => set({ date: value })}>
                  <span>{index === 0 ? "Today" : day.toLocaleDateString("en-GB", { weekday: "short" })}</span>
                  <b>{day.getDate()}</b>
                  <small>{day.toLocaleDateString("en-GB", { month: "short" })}</small>
                </button>;
              })}
            </div>
          </div>

          {form.kind === "booking" ? <div className="time-block">
            <div className="calendar-label"><span className="field-number">C</span><span>Start time</span><strong>{availabilityLoading ? "Checking live availability…" : availability?.released ? `${availableHours.size} times available` : "Not released · choose a preferred time"}</strong></div>
            <div className="time-grid">
              {HOURS.map((hour) => {
                const unavailable = availabilityLoading || (!!availability?.released && !availableHours.has(hour));
                return <button type="button" key={hour} disabled={unavailable} className={`${form.hour === String(hour) ? "selected" : ""} ${unavailable ? "unavailable" : ""}`} onClick={() => set({ hour: String(hour) })}>
                {hourLabel(hour)}<small>{hour < 12 ? "AM" : "PM"}</small>
                </button>;
              })}
            </div>
            {!availabilityLoading && availability?.released && availableHours.size === 0 && <p className="no-slots">No {form.courtType} courts remain for this date. Choose another day.</p>}
          </div> : <div className="probe-note"><b>Release watch</b><p>We’ll monitor this date and record the moment courts become bookable.</p></div>}

          {form.kind === "booking" && <div className="checkout-band">
            <div className="photo-tile"><img src="/images/padel-racket.jpg" alt="Padel racket and ball beside the court glass" /></div>
            <div className="player-panel">
              <span className="eyebrow dark">Player profile</span>
              <h3>{form.fullName || "Add your details once"}</h3>
              <p>{form.email || "We use these to complete the venue checkout."}</p>
              <button type="button" className="text-action" onClick={() => setShowDetails((open) => !open)}>{showDetails ? "Close details" : form.fullName ? "Edit details" : "Add player details"} <span>→</span></button>
            </div>
            <div className="booking-summary">
              <span className="eyebrow">Selected</span>
              <strong>{selectedDay.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</strong>
              <b>{hourLabel(Number(form.hour))} {Number(form.hour) < 12 ? "AM" : "PM"}</b>
              <small>{venueLabel(form.venue)}</small>
            </div>
          </div>}

          {form.kind === "booking" && showDetails && <div className="details-drawer">
            <div className="drawer-title"><span>Player details</span><p>Required by the venue. Payment details are never stored.</p></div>
            <div className="details-grid">
              <label>Full name<input required value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} /></label>
              <label>Email<input required type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></label>
              <label>Mobile<input required type="tel" value={form.mobile} onChange={(e) => set({ mobile: e.target.value })} /></label>
              <label>Date of birth<input required type="date" value={form.dob} onChange={(e) => set({ dob: e.target.value })} /></label>
              <label>Gender<select required value={form.gender} onChange={(e) => set({ gender: e.target.value as typeof form.gender })}><option value="" disabled>Select…</option><option value="f">Female</option><option value="m">Male</option><option value="n">Prefer not to say</option></select></label>
              <label>Other phone <small>optional</small><input type="tel" value={form.otherTel} onChange={(e) => set({ otherTel: e.target.value })} /></label>
            </div>
          </div>}

          <div className="submit-row">
            <div><span>Automation</span><strong>{form.kind === "probe" ? "Watch and report" : "Stop safely at payment"}</strong></div>
            <button className="primary-cta" type="submit" disabled={submitting}>{submitting ? "Setting up…" : form.kind === "probe" ? "Watch this date" : "Queue this court"}<span>↗</span></button>
          </div>
        </form>

        <section className="journey-section">
          <div className="section-heading compact"><span className="step">02</span><div><span className="eyebrow dark">Your court diary</span><h2>Upcoming &amp; recent</h2></div></div>
          {jobs.length === 0 ? <div className="empty-journey"><p>No sessions queued yet.</p><span>Your next court will appear here.</span></div> : <div className="journey-list">
            {jobs.map((job) => <JobCard key={job.id} job={job} onRun={() => act(() => api.runNow(job.id))} onDelete={() => act(() => api.deleteJob(job.id))} />)}
          </div>}
        </section>
      </main>

      <footer><div className="brand"><Mark /><span>COURT/01</span></div><p>Less refreshing. More playing.</p><span>Built for London courts · {new Date().getFullYear()}</span></footer>
    </div>
  );
}

function JobCard({ job, onRun, onDelete }: { job: BookingJob; onRun: () => void; onDelete: () => void }) {
  const [artifacts, setArtifacts] = useState<string[]>([]);
  useEffect(() => {
    if (job.status === "success" || job.status === "failed") api.artifacts(job.id).then(setArtifacts).catch(() => {});
  }, [job.id, job.status]);
  const date = new Date(`${job.date}T12:00:00`);
  return <article className="journey-card">
    <div className="date-stamp"><span>{date.toLocaleDateString("en-GB", { month: "short" })}</span><b>{date.getDate()}</b></div>
    <div className="journey-main"><span className="eyebrow dark">{job.kind === "probe" ? "Release watch" : venueLabel(job.venue)}</span><h3>{job.kind === "probe" ? "Watching for courts" : `${job.courtType} · ${hourLabel(job.hour ?? 0)}`}</h3><p>{job.result?.kind === "booking" ? `${job.result.court} · ${job.result.price || ""} · payment page ready` : job.error || `Starts ${fmt(job.fireAt)}`}</p></div>
    <span className={`status ${job.status}`}><i />{job.status}</span>
    <div className="card-actions">
      {artifacts.filter((file) => file.endsWith(".png")).slice(-1).map((file) => <a key={file} href={`/api/jobs/${job.id}/artifacts/${file}`} target="_blank" rel="noreferrer">View</a>)}
      {job.status !== "running" && <button type="button" onClick={onRun}>{job.status === "failed" ? "Retry" : "Run now"}</button>}
      {job.status !== "running" && <button type="button" className="remove" onClick={onDelete} aria-label="Delete job">×</button>}
    </div>
  </article>;
}
