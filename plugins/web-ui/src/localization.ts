import { configureLocalization, msg, str, type LocaleModule } from "@lit/localize";
import { defaultEnglish, getTranslations, setTranslations } from "@mariozechner/mini-lit/dist/i18n.js";
import { allLocales, sourceLocale, targetLocales } from "./generated/locale-codes.ts";

export type AppLocale = (typeof allLocales)[number];

const LOCALE_STORAGE_KEY = "qm.web-ui.locale";

const localeLoaders: Record<(typeof targetLocales)[number], () => Promise<LocaleModule>> = {
  "zh-Hans": () => import("./generated/locales/zh-Hans.ts"),
};

const { getLocale, setLocale } = configureLocalization({
  sourceLocale,
  targetLocales,
  loadLocale: (locale) => localeLoaders[locale as (typeof targetLocales)[number]](),
});

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  const valueNormalized = value?.trim().replaceAll("_", "-");
  if (!valueNormalized) return null;
  try {
    const locale = new Intl.Locale(valueNormalized);
    if (locale.language === "en") return "en";
    if (locale.language !== "zh" || locale.script === "Hant") return null;
    if (!locale.region || locale.region === "CN" || locale.region === "SG" || locale.script === "Hans")
      return "zh-Hans";
  } catch {
    return null;
  }
  return null;
}

export function resolveLocale(options: {
  stored?: string | null;
  deployment?: string | null;
  browser?: readonly string[];
}): AppLocale {
  const candidates = [options.stored, options.deployment, ...(options.browser ?? [])];
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return sourceLocale;
}

function storedLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function deploymentLocale(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="web-ui-default-locale"]')?.content ?? null;
}

function browserLocales(): readonly string[] {
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

function updateDocument(locale: AppLocale): void {
  document.documentElement.lang = locale;
  const label = document.querySelector<HTMLMetaElement>('meta[name="brand-self-label"]')?.content || "QM";
  document.title = `${label} · ${msg("Web")}`;
}

export async function initializeLocale(): Promise<AppLocale> {
  const requested = resolveLocale({
    stored: storedLocale(),
    deployment: deploymentLocale(),
    browser: browserLocales(),
  });
  document.documentElement.lang = requested;
  try {
    await setLocale(requested);
  } catch {
    await setLocale(sourceLocale);
  }
  const locale = getLocale() as AppLocale;
  syncMiniLitLocalization();
  updateDocument(locale);
  return locale;
}

export function activeLocale(): AppLocale {
  return getLocale() as AppLocale;
}

export function syncMiniLitLocalization(): void {
  const current = getTranslations();
  const messages = {
    ...(current.en ?? defaultEnglish),
    Copy: msg("Copy"),
    "Copy code": msg("Copy code"),
    "Copied!": msg("Copied!"),
  };
  const locales = new Set([...Object.keys(current), "en", "de", "zh", "zh-Hans"]);
  setTranslations(Object.fromEntries([...locales].map((locale) => [locale, messages])));
}

export function saveLocale(locale: string): void {
  const normalized = normalizeLocale(locale) ?? sourceLocale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, normalized);
  } catch {
    void 0;
  }
  location.reload();
}

export function formatDateTime(value: number | string | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(activeLocale(), options).format(new Date(value));
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(activeLocale(), options).format(value);
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  const formatter = new Intl.RelativeTimeFormat(activeLocale(), { numeric: "auto" });
  if (elapsed < 60_000) return formatter.format(0, "second");
  if (elapsed < 3_600_000) return formatter.format(-Math.floor(elapsed / 60_000), "minute");
  if (elapsed < 86_400_000) return formatter.format(-Math.floor(elapsed / 3_600_000), "hour");
  return formatter.format(-Math.floor(elapsed / 86_400_000), "day");
}

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) {
    return new Intl.NumberFormat(activeLocale(), { style: "unit", unit: "byte", unitDisplay: "short" }).format(bytes);
  }
  if (bytes < 1024 * 1024) {
    return new Intl.NumberFormat(activeLocale(), {
      style: "unit",
      unit: "kilobyte",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(bytes / 1024);
  }
  return new Intl.NumberFormat(activeLocale(), {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(bytes / 1024 / 1024);
}

export function localizedStatus(value: string): string {
  switch (value) {
    case "pending":
      return msg("Pending");
    case "running":
      return msg("Running");
    case "done":
      return msg("Done");
    case "failed":
      return msg("Failed");
    case "ok":
      return msg("Completed");
    case "refused":
      return msg("Refused");
    case "pending_approval":
      return msg("Pending approval");
    case "queued":
      return msg("Queued");
    case "silent":
      return msg("Silent");
    case "react":
      return msg("Reacted");
    case "working":
      return msg("Working");
    case "awaiting_approval":
      return msg("Awaiting approval");
    case "idle":
      return msg("Idle");
    case "in_progress":
      return msg("In progress");
    case "completed":
      return msg("Completed");
    case "skipped":
      return msg("Skipped");
    case "stopped":
      return msg("Stopped");
    case "archived":
      return msg("Archived");
    case "draft":
      return msg("Draft");
    case "reviewed":
      return msg("Reviewed");
    case "published":
      return msg("Published");
    case "exited":
      return msg("Exited");
    case "active":
      return msg("Active");
    case "revoked":
      return msg("Revoked");
    case "used":
      return msg("Used");
    case "approved":
      return msg("Approved");
    case "declined":
      return msg("Declined");
    case "expired":
      return msg("Expired");
    case "enabled":
      return msg("Enabled");
    case "disabled":
      return msg("Disabled");
    case "accepted":
      return msg("Accepted");
    case "connected":
      return msg("Connected");
    case "needsReconnect":
      return msg("Reconnect required");
    case "denied":
      return msg("Denied");
    case "error":
      return msg("Error");
    case "materialized":
      return msg("Available");
    default:
      return value;
  }
}

export function localizedError(
  code: string,
  details?: { retryAfterMs?: unknown; budget?: { spentUsd?: unknown; limitUsd?: unknown } },
): string | null {
  switch (code) {
    case "bad_core_response":
      return msg("The server returned an invalid response.");
    case "bad_gateway":
      return msg("The service is temporarily unavailable.");
    case "forbidden":
      return msg("You do not have permission to do that.");
    case "forbidden_scope":
      return msg("You do not have access to that project.");
    case "forbidden_thread":
      return msg("You do not have access to that conversation.");
    case "not_allowed":
      return msg("This account is not allowed on this instance. Ask an administrator to add it.");
    case "not_built":
      return msg("This feature is not available in this build.");
    case "not_configured":
      return msg("This feature has not been configured.");
    case "not_found":
      return msg("The requested item was not found.");
    case "rate_limited":
      if (typeof details?.retryAfterMs === "number" && Number.isFinite(details.retryAfterMs)) {
        const delay = formatNumber(Math.max(0, Math.ceil(details.retryAfterMs / 1000)), {
          style: "unit",
          unit: "second",
          unitDisplay: "long",
        });
        return msg(str`Too many requests. Try again in ${delay}.`);
      }
      return msg("Too many requests. Try again later.");
    case "budget_exceeded":
      if (
        typeof details?.budget?.spentUsd === "number" &&
        Number.isFinite(details.budget.spentUsd) &&
        typeof details.budget.limitUsd === "number" &&
        Number.isFinite(details.budget.limitUsd)
      ) {
        const spent = formatNumber(details.budget.spentUsd, { style: "currency", currency: "USD" });
        const limit = formatNumber(details.budget.limitUsd, { style: "currency", currency: "USD" });
        return msg(str`The usage budget has been reached (${spent} of ${limit}). Try again later.`);
      }
      return msg("The usage budget has been reached. Try again later.");
    case "internal_access_denied":
      return msg("This workspace is limited to internal members.");
    case "security_quarantine":
      return msg("This request was blocked by the workspace security policy.");
    case "payload_too_large":
      return msg("The request is too large.");
    case "hash_mismatch":
      return msg("The upload could not be verified. Try uploading it again.");
    case "harness_not_approved":
      return msg("This agent runtime is not approved for the selected project.");
    case "model_not_supported":
      return msg("The selected model is not supported by this agent runtime.");
    case "model_not_enabled":
      return msg("The selected model is not enabled for this project.");
    case "model_provider_unavailable":
      return msg("The selected model provider is not configured on this deployment.");
    case "effort_not_supported":
      return msg("The selected reasoning effort is not supported by this model.");
    case "fast_mode_invalid":
      return msg("Fast mode is not available with the selected settings.");
    case "oauth_denied":
      return msg("Connection permission was denied.");
    case "oauth_callback_failed":
      return msg("The connection could not be completed.");
    case "oauth_not_configured":
      return msg("This connection has not been configured by an administrator.");
    case "redirect_not_allowed":
      return msg("The connection returned to an invalid address.");
    case "rename_failed":
      return msg("The app could not be renamed.");
    case "display_name_failed":
      return msg("The app name could not be updated.");
    case "archive_failed":
      return msg("The item could not be archived.");
    case "restore_failed":
      return msg("The item could not be restored.");
    case "memory_revision_conflict":
      return msg("Memory changed elsewhere. Refresh and try again.");
    case "context_policy_conflict":
      return msg("Project settings changed elsewhere. Refresh and try again.");
    case "skill_name_required":
      return msg("Enter a skill name.");
    case "skill_description_required":
      return msg("Enter a skill description.");
    case "skill_body_required":
      return msg("Enter skill instructions.");
    case "skill_already_exists":
      return msg("A skill with that name already exists.");
    case "invalid_name":
      return msg("Enter a valid name.");
    case "invalid_member":
      return msg("Enter a valid member.");
    case "empty_message":
      return msg("Enter a message before sending.");
    case "approval_denied":
      return msg("Denied.");
    case "approval_not_visible":
      return msg("That approval is no longer available in this project.");
    case "context_access_denied":
      return msg("You do not have access to that project.");
    case "conversation_context_mismatch":
      return msg("That conversation belongs to a different project.");
    case "project_membership_changed":
      return msg("Project membership changed. Refresh and try again.");
    case "runtime_not_approved":
      return msg("This agent runtime is not approved.");
    case "session_busy":
      return msg("This conversation is busy. Try again in a moment.");
    case "thread_owner_mismatch":
      return msg("Start this conversation from your own account.");
    case "ask_not_found":
      return msg("That access request no longer exists.");
    case "ask_resolved":
      return msg("That access request is no longer available.");
    case "ask_self":
      return msg("You already own this credential. Share it directly instead.");
    case "credential_expired":
      return msg("This credential has expired. Reconnect or replace it.");
    case "credential_not_found":
      return msg("That credential no longer exists.");
    case "credential_unavailable":
      return msg("This credential is unavailable.");
    case "grant_expired":
      return msg("This credential grant has expired.");
    case "grant_not_found":
      return msg("That credential grant no longer exists.");
    case "grant_revoked":
      return msg("This credential grant was revoked.");
    case "grant_scope_mismatch":
      return msg("This credential grant belongs to a different conversation.");
    case "grant_used":
      return msg("This one-time credential grant has already been used.");
    case "gateway_timeout":
      return msg("The app gateway request failed.");
    default:
      return null;
  }
}
