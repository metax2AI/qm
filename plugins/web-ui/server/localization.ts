export type WebLocale = "en" | "zh-Hans";

export function normalizeWebLocale(value: string | undefined): WebLocale | null {
  const locale = value?.trim().replaceAll("_", "-").toLowerCase();
  if (locale === "en" || locale?.startsWith("en-")) return "en";
  if (locale === "zh" || locale === "zh-cn" || locale === "zh-sg" || locale === "zh-hans") return "zh-Hans";
  return null;
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
