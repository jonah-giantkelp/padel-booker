export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
