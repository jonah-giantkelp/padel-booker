import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BookingJob } from "./types";

/**
 * File-backed job store: the whole queue lives in one JSON file so it survives
 * restarts and can be inspected/edited by hand. Writes are serialized and
 * atomic (tmp file + rename).
 */
export class JobStore {
  private jobs: BookingJob[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    try {
      this.jobs = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.jobs = [];
    }
    // A job left "running" by a crash/restart should run again.
    let dirty = false;
    for (const job of this.jobs) {
      if (job.status === "running") {
        job.status = "scheduled";
        dirty = true;
      }
    }
    if (dirty) await this.persist();
  }

  list(): BookingJob[] {
    return [...this.jobs].sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  }

  get(id: string): BookingJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  async add(job: Omit<BookingJob, "id" | "createdAt">): Promise<BookingJob> {
    const full: BookingJob = { ...job, id: randomUUID(), createdAt: new Date().toISOString() };
    this.jobs.push(full);
    await this.persist();
    return full;
  }

  async update(id: string, patch: Partial<BookingJob>): Promise<BookingJob> {
    const job = this.get(id);
    if (!job) throw new Error(`No job ${id}`);
    Object.assign(job, patch);
    await this.persist();
    return job;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length === before) return false;
    await this.persist();
    return true;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.jobs, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, this.file);
    });
    return this.writeChain;
  }
}
