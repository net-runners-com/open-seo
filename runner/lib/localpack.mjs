import { parseHTML } from "linkedom";
import { hostnameMatches, isGoogleHost } from "./domains.mjs";

/**
 * Parse a Google Local Finder page and return the 1-based position of the
 * entry whose website link matches targetDomain.
 *
 * Constraint: matching is by website link only. A GBP listing that shows no
 * website button cannot be matched (no businessName in the config), so it
 * yields null even when the business is present in the pack.
 */
export function parseLocalFinderResults(html, targetDomain) {
  const { document } = parseHTML(html);
  const feed = document.querySelector('[role="feed"]');
  if (!feed) return { localPackPosition: null, entries: [] };

  const entries = [];
  for (const child of feed.children) {
    const heading = child.querySelector('[role="heading"]');
    if (!heading) continue;
    let website = null;
    for (const anchor of child.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("http")) continue;
      try {
        const { hostname } = new URL(href);
        if (isGoogleHost(hostname)) continue;
        website = href;
        break;
      } catch {
        continue;
      }
    }
    entries.push({ name: heading.textContent.trim(), website });
  }

  const matchIndex = entries.findIndex((entry) => {
    if (!entry.website) return false;
    try {
      return hostnameMatches(new URL(entry.website).hostname, targetDomain);
    } catch {
      return false;
    }
  });

  return {
    localPackPosition: matchIndex === -1 ? null : matchIndex + 1,
    entries,
  };
}
