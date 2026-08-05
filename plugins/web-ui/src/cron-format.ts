import { addDays, isSameDay } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { msg, str } from "@lit/localize";
import { relTime } from "./ui.ts";
import { formatDateTime, formatNumber } from "./localization.ts";

export interface CronTimingView {
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
}

function humanizeCronInterval(ms: number): string {
  const units: Array<[number, "week" | "day" | "hour" | "minute"]> = [
    [604_800_000, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, unit] of units) {
    if (ms >= size && ms % size === 0) {
      return formatNumber(ms / size, { style: "unit", unit, unitDisplay: "short" });
    }
  }
  if (ms >= 60_000) {
    return formatNumber(ms / 60_000, {
      style: "unit",
      unit: "minute",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    });
  }
  return formatNumber(Math.round(ms / 1000), { style: "unit", unit: "second", unitDisplay: "short" });
}

export function cronScheduleSummary(c: CronTimingView): string {
  if (c.schedule.cron) return msg(str`cron ${c.schedule.cron.trim().replace(/\s+/g, " ")}`);
  return c.schedule.everyMs != null ? msg(str`every ${humanizeCronInterval(c.schedule.everyMs)}`) : msg("one-time");
}

export function cronScheduleDetail(c: CronTimingView): string {
  const summary = cronScheduleSummary(c);
  const label = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (c.schedule.cron) {
    const tz = c.schedule.timezone?.trim();
    return tz ? msg(str`${label} (${tz})`) : msg(str`${label} (default timezone)`);
  }
  if (c.schedule.firstFireAt == null) return label;
  if (c.schedule.everyMs != null && c.lastFiredAt != null) return label;
  const dateTime = formatCronDateTime(c.schedule.firstFireAt, Date.now(), c.schedule.timezone);
  return c.schedule.everyMs != null ? msg(str`${label} - first run ${dateTime}`) : msg(str`${label} - run ${dateTime}`);
}

export function cronNextFire(c: CronTimingView): number | null {
  if (c.archived || !c.enabled) return null;
  if (c.nextFireAt != null && Number.isFinite(c.nextFireAt)) return c.nextFireAt;
  if (c.schedule.cron) return null;
  if (c.lastFiredAt == null) return c.schedule.firstFireAt ?? c.createdAt;
  if (c.schedule.everyMs == null) return null;
  return c.lastFiredAt + c.schedule.everyMs;
}

export function cronRunSummary(c: CronTimingView, now = Date.now()): string {
  const next = cronNextFire(c);
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  if (next != null) {
    const dateTime = formatCronDateTime(next, now, tz);
    return next <= now ? msg(str`due ${dateTime}`) : msg(str`next ${dateTime}`);
  }
  if (c.lastFiredAt != null) return msg(str`last ${relTime(c.lastFiredAt)}`);
  if (c.schedule.firstFireAt != null) return msg(str`first ${formatCronDateTime(c.schedule.firstFireAt, now, tz)}`);
  return msg("never fired");
}

export function cronRunSummaryTitle(c: CronTimingView): string {
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  const next = cronNextFire(c);
  if (next != null) return msg(str`Next run: ${formatTitleDateTime(next, tz)}`);
  if (c.lastFiredAt != null) return msg(str`Last fired: ${formatTitleDateTime(c.lastFiredAt, tz)}`);
  if (c.schedule.firstFireAt != null) return msg(str`First run: ${formatTitleDateTime(c.schedule.firstFireAt, tz)}`);
  return msg("Never fired");
}

export function formatCronDateTime(ms: number, now = Date.now(), timeZone?: string): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (timeZone) {
    const zonedDate = zoned(ms, timeZone);
    const zonedToday = zoned(now, timeZone);
    if (zonedDate && zonedToday) {
      const time = formatTime(ms, timeZone);
      if (isSameDay(zonedDate, zonedToday)) return time;
      if (isSameDay(zonedDate, addDays(zonedToday, 1))) return msg(str`tomorrow ${time}`);
      const dateOpts: Intl.DateTimeFormatOptions =
        zonedDate.getFullYear() === zonedToday.getFullYear()
          ? { month: "short", day: "numeric", timeZone }
          : { month: "short", day: "numeric", year: "numeric", timeZone };
      return `${formatDateTime(date, dateOpts)} ${time}`;
    }
  }
  const time = formatTime(ms);
  if (isSameDay(date, today)) return time;
  if (isSameDay(date, addDays(today, 1))) return msg(str`tomorrow ${time}`);
  const dateOpts: Intl.DateTimeFormatOptions =
    date.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `${formatDateTime(date, dateOpts)} ${time}`;
}

function calendarTimezone(schedule: { timezone?: string }): string | undefined {
  const configured = schedule.timezone?.trim();
  if (configured) return configured;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const TIMEZONE_VALIDITY = new Map<string, boolean>();

function isIntlTimezone(timeZone: string): boolean {
  let valid = TIMEZONE_VALIDITY.get(timeZone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      valid = true;
    } catch {
      valid = false;
    }
    TIMEZONE_VALIDITY.set(timeZone, valid);
  }
  return valid;
}

function zoned(ms: number, timeZone: string): TZDate | null {
  if (!isIntlTimezone(timeZone)) return null;
  try {
    const date = new TZDate(ms, timeZone);
    return Number.isNaN(date.getFullYear()) ? null : date;
  } catch {
    return null;
  }
}

function formatTime(ms: number, timeZone?: string): string {
  try {
    return formatDateTime(ms, {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return formatDateTime(ms, { hour: "numeric", minute: "2-digit" });
  }
}

function formatTitleDateTime(ms: number, timeZone?: string): string {
  try {
    return formatDateTime(ms, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return formatDateTime(ms, { dateStyle: "medium", timeStyle: "short" });
  }
}
