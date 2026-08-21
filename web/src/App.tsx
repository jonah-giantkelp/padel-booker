import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, AppConfig, AvailabilityPreview, BookingJob, CourtType, NewJob } from "./api";

const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);
// Weeks the calendar can page through. Anything beyond the site's release
// window simply queues a job that fires at that date's release moment.
const WEEKS = 8;
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

const PLAYER_KEY = "padel-booker:player";
type PlayerProfile = { fullName: string; email: string; mobile: string; otherTel: string; dob: string; gender: "" | "f" | "m" | "n" };

function loadProfile(): Partial<PlayerProfile> {
  try { return JSON.parse(localStorage.getItem(PLAYER_KEY) || "{}"); }
  catch { return {}; }
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
  const [form, setForm] = useState(() => ({
    venue: "bethnal-green-gardens",
    date: "",
    hour: "",
    courtType: "padel" as CourtType,
    courtNumber: "",
    fullName: "",
    email: "",
    mobile: "",
    otherTel: "",
    dob: "",
    gender: "" as "" | "f" | "m" | "n",
    ...loadProfile(),
    cardNumber: "",
    cardExpiry: "",
    cardCvc: "",
    cardName: "",
    cardPostcode: ""
  }));
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const profileSaved = !!(form.fullName && form.email && form.mobile && form.dob && form.gender);
  const [weekOffset, setWeekOffset] = useState(0);

  const days = useMemo(() => Array.from({ length: WEEKS * 7 }, (_, i) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + i);
    return date;
  }), []);
  const weeks = useMemo(
    () => Array.from({ length: WEEKS }, (_, w) => days.slice(w * 7, w * 7 + 7)),
    [days]
  );

  const refresh = useCallback(() => api.jobs().then(setJobs).catch((e) => setError(e.message)), []);
  useEffect(() => {
    api.config().then(setConfig).catch((e) => setError(e.message));
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!form.date) { setAvailability(null); setAvailabilityLoading(false); return; }
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
  // If the picked time turns out to be taken on a released day, drop the pick
  // rather than silently choosing a different time.
  useEffect(() => {
    if (!form.hour || !availability?.released || availableHours.has(Number(form.hour))) return;
    set({ hour: "" });
  }, [availability, availableHours, form.hour]);

  function saveProfile() {
    setError(null);
    if (!form.fullName || !form.email || !form.mobile || !form.dob || !form.gender) {
      setError("Fill in name, email, mobile, date of birth and gender to save your profile.");
      return;
    }
    const profile: PlayerProfile = {
      fullName: form.fullName, email: form.email, mobile: form.mobile,
      otherTel: form.otherTel, dob: form.dob, gender: form.gender
    };
    localStorage.setItem(PLAYER_KEY, JSON.stringify(profile));
    setShowDetails(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const missing: string[] = [];
    if (!form.date) missing.push("a day");
    if (!form.hour) missing.push("a start time");
    if (!form.fullName) missing.push("full name");
    if (!form.email) missing.push("email");
    if (!form.mobile) missing.push("mobile");
    if (!form.dob) missing.push("date of birth");
    if (!form.gender) missing.push("gender");
    if (!form.cardNumber) missing.push("card number");
    if (!form.cardExpiry) missing.push("card expiry");
    if (!form.cardCvc) missing.push("card CVC");
    if (!form.cardName) missing.push("name on card");
    if (!form.cardPostcode) missing.push("billing postcode");
    if (missing.length) {
      if (!form.fullName || !form.email || !form.mobile || !form.dob || !form.gender) setShowDetails(true);
      setError(`Before this booking can be queued, add: ${missing.join(", ")}.`);
      return;
    }
    setSubmitting(true);
    try {
      const payload: NewJob = {
        kind: "booking", venue: form.venue, date: form.date, time: form.hour,
        courtType: form.courtType, courtNumber: form.courtNumber || undefined,
        stopAt: "paid",
        details: {
          fullName: form.fullName, email: form.email, mobile: form.mobile,
          otherTel: form.otherTel || undefined, dob: form.dob,
          gender: form.gender as "f" | "m" | "n"
        },
        card: {
          number: form.cardNumber, expiry: form.cardExpiry, cvc: form.cardCvc,
          name: form.cardName, postcode: form.cardPostcode
        }
      };
      const created = await api.createJob(payload);
      set({ cardNumber: "", cardExpiry: "", cardCvc: "" });
      setNotice(`You're set. We'll start at ${fmt(created.fireAt)}, book the court and pay automatically.`);
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

  const selectedDay = days.find((day) => isoDate(day) === form.date);
  const visibleWeekStart = weeks[weekOffset][0];

  return (
    <div className="app-shell">
      <nav className="topbar">
        <a className="brand" href="#booking"><Mark /><span>Padel Booker</span></a>
        <div className="nav-meta"><b>{jobs.filter((j) => j.status === "scheduled").length} upcoming</b><button onClick={() => api.logout().then(() => location.reload())}>Sign out</button></div>
      </nav>

      <main id="booking">
        {error && <div className="toast error">{error}<button onClick={() => setError(null)}>×</button></div>}
        {notice && <div className="toast success">{notice}<button onClick={() => setNotice(null)}>×</button></div>}

        <form className="booking-studio" onSubmit={submit}>
          <div className="section-heading">
            <div><h2>Build your session</h2></div>
          </div>

          <div className="venue-line">
            <label><span>Venue</span><select value={form.venue} onChange={(e) => set({ venue: e.target.value })}>
              {(config?.venues ?? [form.venue]).map((venue) => <option key={venue} value={venue}>{venueLabel(venue)}</option>)}
            </select></label>
            <div className="sport-pills">
              <button type="button" className={form.courtType === "padel" ? "active" : ""} onClick={() => set({ courtType: "padel" })}>Padel</button>
              <button type="button" className={form.courtType === "tennis" ? "active" : ""} onClick={() => set({ courtType: "tennis" })}>Tennis</button>
            </div>
          </div>

          <div className="calendar-block">
            <div className="calendar-label">
              <span>Select a day</span>
              <div className="week-nav">
                <strong>{visibleWeekStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</strong>
                <button type="button" aria-label="Previous week" disabled={weekOffset === 0} onClick={() => setWeekOffset((w) => Math.max(0, w - 1))}>←</button>
                <button type="button" aria-label="Next week" disabled={weekOffset === WEEKS - 1} onClick={() => setWeekOffset((w) => Math.min(WEEKS - 1, w + 1))}>→</button>
              </div>
            </div>
            <div className="week-viewport">
              <div className="week-track" style={{ transform: `translateX(-${weekOffset * 100}%)` }}>
                {weeks.map((week, w) => (
                  <div className="week-strip" key={w}>
                    {week.map((day, d) => {
                      const value = isoDate(day);
                      return <button type="button" key={value} className={form.date === value ? "selected" : ""} onClick={() => set({ date: value })}>
                        <span>{w === 0 && d === 0 ? "Today" : day.toLocaleDateString("en-GB", { weekday: "short" })}</span>
                        <b>{day.getDate()}</b>
                        <small>{day.toLocaleDateString("en-GB", { month: "short" })}</small>
                      </button>;
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {form.date && <div className="time-block">
            <div className="calendar-label"><span>Start time</span><strong>{
              availabilityLoading ? "Checking live availability…"
                : availability?.released ? `${availableHours.size} times available`
                : availability?.scheduled ? "Not released yet · choose a preferred time"
                : "Couldn't read live availability · choose a preferred time"
            }</strong></div>
            <div className="time-grid">
              {HOURS.map((hour) => {
                const unavailable = !!availability?.released && !availableHours.has(hour);
                return <button type="button" key={hour} disabled={unavailable} className={`${form.hour === String(hour) ? "selected" : ""} ${unavailable ? "unavailable" : ""}`} onClick={() => set({ hour: String(hour) })}>
                {hourLabel(hour)}<small>{hour < 12 ? "AM" : "PM"}</small>
                </button>;
              })}
            </div>
            {!availabilityLoading && availability?.released && availableHours.size === 0 && <p className="no-slots">No {form.courtType} courts remain for this date. Choose another day.</p>}
          </div>}

          <div className="checkout-band">
            <div className="photo-tile"><img src="/images/padel-racket.jpg" alt="Padel racket and ball beside the court glass" /></div>
            <div className="player-panel">
              <span className="eyebrow dark">Player profile</span>
              <h3>{profileSaved ? form.fullName : "Add your details once"}</h3>
              <p>{profileSaved ? `${form.email} · ${form.mobile}` : "We use these to complete the venue checkout."}</p>
              {!profileSaved && <small className="required-hint">ⓘ The venue requires these to book a court — save them before queueing.</small>}
              <button type="button" className="text-action" onClick={() => setShowDetails((open) => !open)}>{showDetails ? "Close details" : profileSaved ? "Edit profile" : "Add player details"} <span>→</span></button>
            </div>
            <div className="booking-summary">
              <span className="eyebrow">Selected</span>
              {selectedDay && form.hour ? <>
                <strong>{selectedDay.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</strong>
                <b>{hourLabel(Number(form.hour))} {Number(form.hour) < 12 ? "AM" : "PM"}</b>
                <small>{venueLabel(form.venue)}</small>
              </> : <p className="summary-empty">Pick a day and a start time to see your session here.</p>}
            </div>
          </div>

          {showDetails && <div className="details-drawer">
            <div className="drawer-title"><span>Player details</span><p>Required by the venue. Saved on this device so you only enter them once.</p></div>
            <div className="details-grid">
              <label>Full name<input required value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} /></label>
              <label>Email<input required type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></label>
              <label>Mobile<input required type="tel" value={form.mobile} onChange={(e) => set({ mobile: e.target.value })} /></label>
              <label>Date of birth<input required type="date" value={form.dob} onChange={(e) => set({ dob: e.target.value })} /></label>
              <label>Gender<select required value={form.gender} onChange={(e) => set({ gender: e.target.value as typeof form.gender })}><option value="" disabled>Select…</option><option value="f">Female</option><option value="m">Male</option><option value="n">Prefer not to say</option></select></label>
              <label>Other phone <small>optional</small><input type="tel" value={form.otherTel} onChange={(e) => set({ otherTel: e.target.value })} /></label>
            </div>
            <button type="button" className="drawer-save" onClick={saveProfile}>Save profile</button>
          </div>}

          <div className="details-drawer">
            <div className="drawer-title"><span>Payment</span><p>The booking is paid for you the moment it's secured.</p></div>
            <div className="details-grid">
              <label>Card number<input required inputMode="numeric" autoComplete="cc-number" placeholder="4242 4242 4242 4242" value={form.cardNumber} onChange={(e) => set({ cardNumber: e.target.value })} /></label>
              <label>Expiry<input required placeholder="MM/YY" autoComplete="cc-exp" value={form.cardExpiry} onChange={(e) => set({ cardExpiry: e.target.value })} /></label>
              <label>CVC<input required inputMode="numeric" autoComplete="cc-csc" placeholder="123" value={form.cardCvc} onChange={(e) => set({ cardCvc: e.target.value })} /></label>
              <label>Name on card<input required autoComplete="cc-name" value={form.cardName} onChange={(e) => set({ cardName: e.target.value })} /></label>
              <label>Billing postcode<input required autoComplete="postal-code" value={form.cardPostcode} onChange={(e) => set({ cardPostcode: e.target.value })} /></label>
            </div>
            <p className="card-note">Encrypted at rest, used once for this booking, deleted after it succeeds. If the bank demands a 3DS check the job fails with the challenge screenshotted — a purchase on this card earlier the same evening makes that much less likely.</p>
          </div>

          <div className="submit-row">
            <button className="primary-cta" type="submit" disabled={submitting}>{submitting ? "Setting up…" : "Queue this court"}<span>↗</span></button>
          </div>
        </form>

        {jobs.length > 0 && <section className="journey-section">
          <div className="section-heading compact"><div><span className="eyebrow dark">Court diary</span><h2>Upcoming &amp; recent</h2></div></div>
          <div className="journey-list">
            {jobs.map((job) => <JobCard key={job.id} job={job} onRun={() => act(() => api.runNow(job.id))} onDelete={() => act(() => api.deleteJob(job.id))} />)}
          </div>
        </section>}
      </main>
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
    <div className="journey-main"><span className="eyebrow dark">{job.kind === "probe" ? "Release watch" : venueLabel(job.venue)}{job.ownerName ? ` · ${job.ownerName}` : ""}</span><h3>{job.kind === "probe" ? "Watching for courts" : `${job.courtType} · ${hourLabel(job.hour ?? 0)}`}</h3><p>{job.result?.kind === "booking" ? `${job.result.court} · ${job.result.price || ""} · ${
      job.result.stageReached === "paid" ? `paid with card ····${job.cardLast4 || ""}` :
      job.result.stageReached === "card" ? "card form captured" : "payment page ready"
    }` : job.error || `Starts ${fmt(job.fireAt)}`}</p></div>
    <span className={`status ${job.status}`}><i />{job.status}</span>
    <div className="card-actions">
      {artifacts.filter((file) => file.endsWith(".png")).slice(-1).map((file) => <a key={file} href={`/api/jobs/${job.id}/artifacts/${file}`} target="_blank" rel="noreferrer">View</a>)}
      {job.status !== "running" && <button type="button" onClick={onRun}>{job.status === "failed" ? "Retry" : "Run now"}</button>}
      {job.status !== "running" && <button type="button" className="remove" onClick={onDelete} aria-label="Delete job">×</button>}
    </div>
  </article>;
}
