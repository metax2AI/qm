export type WebLocale = "en" | "zh-Hans";

export function normalizeWebLocale(value: string | undefined): WebLocale | null {
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

export function defaultWebLocale(value: string | undefined): WebLocale {
  return normalizeWebLocale(value) ?? "zh-Hans";
}

export function injectDefaultLocale(html: string, locale: WebLocale | null): string {
  const injected = html.replace(
    /<meta name="web-ui-default-locale" content="[^"]*"\s*\/?>/,
    `<meta name="web-ui-default-locale" content="${locale ?? ""}" />`,
  );
  if (!locale) return injected;
  const title = locale === "zh-Hans" ? "网页" : "Web";
  return injected
    .replace(/<html lang="[^"]*">/, `<html lang="${locale}">`)
    .replace(/<title>([^<]*)<\/title>/, (_match, label: string) => `<title>${label} · ${title}</title>`);
}
