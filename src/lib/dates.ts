// Date helpers. Delivery dates are plain YYYY-MM-DD strings; "today" and the budget week follow Helsinki time.
export const TZ = "Europe/Helsinki";

const DAY_MS = 86_400_000;

/** Helsinki's UTC offset at a given moment, e.g. "+02:00". */
export function helsinkiOffset(at: Date): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return part?.replace("GMT", "") || "+00:00";
}

/** The calendar date in Helsinki at a given moment, as YYYY-MM-DD. */
export function helsinkiDate(at: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Midnight in Helsinki at the start of a date, as a moment in time. */
export function startOfDay(ymd: string): Date {
  const guess = new Date(`${ymd}T00:00:00Z`);
  return new Date(`${ymd}T00:00:00${helsinkiOffset(guess)}`);
}

/** Monday of the week a date falls in. The weekly budget runs Monday to Sunday. */
export function weekStart(ymd: string): string {
  const weekday = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((weekday + 6) % 7));
}

/** "Mon 16 Nov" */
export function fmtDay(ymd: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .format(new Date(`${ymd.slice(0, 10)}T00:00:00Z`))
    .replace(",", "");
}

/** "Thu 12 Nov 15:00" in Helsinki time */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  })
    .format(d)
    .replace(/,/g, "");
}

export const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
