export type CourtType = "padel" | "tennis";

export type JobStatus = "scheduled" | "running" | "success" | "failed";

/**
 * booking — grab a slot when the day is released.
 * probe   — just watch a date and record when it becomes bookable, to discover
 *           the (unpublished) release time.
 */
export type JobKind = "booking" | "probe";

/** How far the automated flow should go. */
export type StopAt = "basket" | "details" | "payment";

/** Customer fields the site's basket page asks for (form #frm_basket_customer). */
export interface BookingDetails {
  fullName: string;
  email: string;
  mobile: string;
  otherTel?: string;
  /** YYYY-MM-DD */
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
  /** last poll that still showed "not available to book yet" (null = open on first check) */
  lastClosedAt: string | null;
  /** first poll that showed the availability table */
  openedAt: string;
  availableCount: number;
  slotCount: number;
}

export interface BookingJob {
  id: string;
  createdAt: string;
  kind: JobKind;
  venue: string;
  /** YYYY-MM-DD — the day being booked/watched */
  date: string;
  /** 0-23 — slot start hour (booking jobs only) */
  hour?: number;
  courtType?: CourtType;
  /** optional specific court number within the type */
  courtNumber?: number;
  details?: BookingDetails;
  stopAt?: StopAt;
  /** ISO timestamp at which the scheduler starts the job */
  fireAt: string;
  status: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: JobResult | ProbeResult;
}
