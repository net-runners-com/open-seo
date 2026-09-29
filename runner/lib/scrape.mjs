import { encodeUuleCanonicalName } from "./uule.mjs";
import { parseOrganicResults } from "./organic.mjs";
import { parseLocalFinderResults } from "./localpack.mjs";

export class CaptchaError extends Error {
  constructor() {
    super("google captcha challenge");
    this.name = "CaptchaError";
  }
}

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const PAGE_SIZE = 10;

function serpUrl(job, start) {
  const params = new URLSearchParams({
    q: job.keyword,
    hl: job.languageCode,
  });
  if (start > 0) params.set("start", String(start));
  if (job.locationName) {
    params.set("uule", encodeUuleCanonicalName(job.locationName));
  }
  return `https://www.google.com/search?${params.toString()}`;
}

function localFinderUrl(job) {
  const params = new URLSearchParams({
    q: job.keyword,
    hl: job.languageCode,
    tbm: "lcl",
  });
  if (job.locationName) {
    params.set("uule", encodeUuleCanonicalName(job.locationName));
  }
  return `https://www.google.com/search?${params.toString()}`;
}

async function fetchPageHtml(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (page.url().includes("/sorry/")) throw new CaptchaError();
    const html = await page.content();
    if (html.includes("captcha-form") || html.includes("g-recaptcha")) {
      throw new CaptchaError();
    }
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function newJobContext(browser, job) {
  return browser.newContext(
    job.device === "mobile"
      ? {
          userAgent: MOBILE_UA,
          viewport: { width: 412, height: 915 },
          isMobile: true,
          hasTouch: true,
          locale: job.languageCode,
        }
      : { locale: job.languageCode },
  );
}

// Execute one job and return a RunnerResult-shaped object (without jobId).
export async function executeJob(browser, job) {
  const context = await newJobContext(browser, job);
  try {
    // Paginate with &start=. `num` is deprecated; absolute position is the
    // organic count of earlier pages plus the in-page position.
    let cumulativeOrganic = 0;
    let found = null;
    const features = new Set();
    for (let start = 0; cumulativeOrganic < job.serpDepth; start += PAGE_SIZE) {
      const html = await fetchPageHtml(context, serpUrl(job, start));
      const parsed = parseOrganicResults(html, job.targetDomain);
      for (const feature of parsed.serpFeatures) features.add(feature);
      if (parsed.position !== null) {
        found = {
          position: cumulativeOrganic + parsed.position,
          url: parsed.url,
        };
        break;
      }
      cumulativeOrganic += parsed.organicCount;
      if (parsed.organicCount === 0) break; // ran out of results
    }

    let localPackPosition = null;
    if (job.includeLocalPack) {
      const html = await fetchPageHtml(context, localFinderUrl(job));
      localPackPosition = parseLocalFinderResults(
        html,
        job.targetDomain,
      ).localPackPosition;
    }

    return {
      status: "ok",
      position: found?.position ?? null,
      url: found?.url ?? null,
      serpFeatures: [...features],
      localPackPosition,
      errorMessage: null,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
