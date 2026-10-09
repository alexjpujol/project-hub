export type SuggestedLink = { url: string; text: string };

const MAX_SUGGESTIONS = 8;

// Pages that tend to hold what people ask about: money, dates, how to sign up.
const USEFUL = /\b(fees?|tuition|costs?|pric(e|es|ing)|rates?|payments?|financial|aid|scholarships?|discounts?|dates?|schedules?|calendar|sessions?|deadlines?|regist(er|ration)|enroll(ment)?|apply|applications?|forms|faqs?|policies)\b/i;

// Matches the keywords above but is rarely what a family is asking about.
const NOT_USEFUL = /\b(staff|tours?|jobs?|careers?|employment|hiring|work at|alumni|donat(e|ions?)|log ?in|sign ?in)\b/i;

// Files a link capture can't read; uploads handle these.
const FILE_EXTENSION = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp[34]|mov)$/i;

/** A comparable form of a URL: no hash, no "www.", no trailing slash. */
export function normalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${path}${url.search}`;
  } catch {
    return input;
  }
}

/**
 * Picks same-site links worth suggesting from a captured page, most likely
 * useful first, skipping the page itself and duplicates.
 */
export function pickSuggestedLinks(
  pageUrl: string,
  links: SuggestedLink[],
): SuggestedLink[] {
  const page = new URL(pageUrl);
  const site = page.hostname.replace(/^www\./, "");
  const seen = new Set([normalizeUrl(pageUrl)]);
  const picked: SuggestedLink[] = [];

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.url, page);
    } catch {
      continue;
    }
    url.hash = "";
    const text = link.text.replace(/\s+/g, " ").replace(/&amp;/g, "&").trim();
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname.replace(/^www\./, "") !== site ||
      FILE_EXTENSION.test(url.pathname) ||
      !text ||
      text.length > 80 ||
      NOT_USEFUL.test(text) ||
      NOT_USEFUL.test(url.pathname.replace(/[-_\/]/g, " ")) ||
      !(USEFUL.test(text) || USEFUL.test(url.pathname.replace(/[-_/]/g, " ")))
    ) {
      continue;
    }
    const key = normalizeUrl(url.toString());
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ url: url.toString(), text });
    if (picked.length === MAX_SUGGESTIONS) break;
  }
  return picked;
}
