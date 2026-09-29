import { parseHTML } from "linkedom";
import { hostnameMatches, isGoogleHost } from "./domains.mjs";

// Ancestors that mark a block as a SERP feature, not an organic hit.
function isFeatureAncestor(el) {
  if (el.getAttribute?.("role") === "feed") return true; // local pack / finder
  if (el.hasAttribute?.("data-initq")) return true; // people also ask
  if (el.getAttribute?.("id") === "taw") return true; // top ads wrapper
  if (el.hasAttribute?.("data-text-ad")) return true; // ads
  return false;
}

function hasFeatureAncestor(el, root) {
  for (let node = el; node && node !== root; node = node.parentElement) {
    if (isFeatureAncestor(node)) return true;
  }
  return false;
}

// "https://example.com › path › page" -> "example.com"
function citeHostname(citeText) {
  const first = citeText.trim().split(/[\s›»]/)[0];
  if (!first) return null;
  try {
    return new URL(first.startsWith("http") ? first : `https://${first}`)
      .hostname;
  } catch {
    return null;
  }
}

function directExternalHref(block) {
  for (const anchor of block.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("http")) continue;
    try {
      if (!isGoogleHost(new URL(href).hostname)) return href;
    } catch {
      continue;
    }
  }
  return null;
}

// Parse a Google SERP page. Organic position counts organic blocks only —
// local pack, ads and PAA never advance it (rank_group semantics).
//
// Primary path (2026 layout, verified live): every organic result sits in a
// `div[data-rpos]` holding an `h3` and a `cite`. Result links are opaque
// `/goto?url=…` redirects, so the domain comes from the cite text and the
// URL falls back to the cite origin when no direct external anchor exists.
export function parseOrganicResults(html, targetDomain) {
  const { document } = parseHTML(html);
  const search = document.querySelector("#search") ?? document.body;

  const organic = [];
  const blocks = [...search.querySelectorAll("[data-rpos]")];
  if (blocks.length > 0) {
    for (const block of blocks) {
      if (block.parentElement?.closest?.("[data-rpos]")) continue; // nested dup
      if (hasFeatureAncestor(block, search)) continue;
      const h3 = block.querySelector("h3");
      const cite = block.querySelector("cite");
      if (!h3 || !cite) continue;
      const hostname = citeHostname(cite.textContent);
      if (!hostname || isGoogleHost(hostname)) continue;
      organic.push({
        hostname,
        url: directExternalHref(block) ?? `https://${hostname}`,
      });
    }
  } else {
    // Legacy layout: an external anchor wrapping (or wrapped by) an h3.
    const seenBlocks = new Set();
    for (const h3 of search.querySelectorAll("h3")) {
      const anchor = h3.closest("a[href]") ?? h3.querySelector("a[href]");
      if (!anchor) continue;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("http")) continue;
      let hostname;
      try {
        hostname = new URL(href).hostname;
      } catch {
        continue;
      }
      if (isGoogleHost(hostname)) continue;
      if (hasFeatureAncestor(anchor, search)) continue;
      let block = anchor;
      for (
        let node = anchor;
        node && node !== search;
        node = node.parentElement
      ) {
        block = node;
      }
      if (seenBlocks.has(block)) continue;
      seenBlocks.add(block);
      organic.push({ hostname, url: href });
    }
  }

  const matchIndex = organic.findIndex((result) =>
    hostnameMatches(result.hostname, targetDomain),
  );
  const serpFeatures = [];
  if (organic.length > 0) serpFeatures.push("organic");
  if (
    document.querySelector('[role="feed"]') ||
    document.querySelector('a[href^="/maps"]')
  ) {
    serpFeatures.push("local_pack");
  }
  if (document.querySelector("[data-initq]")) {
    serpFeatures.push("people_also_ask");
  }

  return {
    position: matchIndex === -1 ? null : matchIndex + 1,
    url: matchIndex === -1 ? null : organic[matchIndex].url,
    serpFeatures,
    organicCount: organic.length,
  };
}
