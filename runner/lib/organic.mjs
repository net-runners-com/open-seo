import { parseHTML } from "linkedom";
import { hostnameMatches, isGoogleHost } from "./domains.mjs";

// Ancestors that mark a result anchor as a SERP feature, not an organic hit.
// Based on the 2026-08 block-structure notes; re-verified via smoke.mjs.
function isFeatureAncestor(el) {
  if (el.getAttribute?.("role") === "feed") return true; // local pack / finder
  if (el.hasAttribute?.("data-initq")) return true; // people also ask
  if (el.getAttribute?.("id") === "taw") return true; // top ads wrapper
  if (el.hasAttribute?.("data-text-ad")) return true; // ads
  return false;
}

// Parse a Google SERP page and return the 1-based organic position of the
// first result whose hostname matches targetDomain (organic blocks only —
// local pack, ads and PAA never count toward position).
export function parseOrganicResults(html, targetDomain) {
  const { document } = parseHTML(html);
  const search = document.querySelector("#search") ?? document.body;

  const seenBlocks = new Set();
  const organic = [];
  let insideFeature = false;
  let sawLocalPack = document.querySelector('[role="feed"]') !== null;
  const sawPaa = document.querySelector("[data-initq]") !== null;

  for (const h3 of search.querySelectorAll("h3")) {
    const anchor = h3.closest("a[href]");
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

    // Walk up to the search root; a feature ancestor disqualifies the block,
    // and the topmost element below the root identifies it for dedup.
    let node = anchor;
    let block = anchor;
    insideFeature = false;
    while (node && node !== search) {
      if (isFeatureAncestor(node)) {
        insideFeature = true;
        break;
      }
      block = node;
      node = node.parentElement;
    }
    if (insideFeature || seenBlocks.has(block)) continue;
    seenBlocks.add(block);
    organic.push({ hostname, url: href });
  }

  const matchIndex = organic.findIndex((result) =>
    hostnameMatches(result.hostname, targetDomain),
  );
  const serpFeatures = [];
  if (organic.length > 0) serpFeatures.push("organic");
  if (sawLocalPack) serpFeatures.push("local_pack");
  if (sawPaa) serpFeatures.push("people_also_ask");

  return {
    position: matchIndex === -1 ? null : matchIndex + 1,
    url: matchIndex === -1 ? null : organic[matchIndex].url,
    serpFeatures,
    organicCount: organic.length,
  };
}
