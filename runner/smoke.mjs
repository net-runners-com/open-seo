#!/usr/bin/env node
// Live one-shot check without a server:
//   node smoke.mjs --keyword "高田馬場 税理士" --domain compass-tax.jp \
//     --location "東京都新宿区" [--local-pack] [--headed] [--device mobile]
import { launch } from "cloakbrowser";
import { executeJob } from "./lib/scrape.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const job = {
  id: "smoke",
  runId: "smoke",
  keyword: arg("keyword", "coffee shop"),
  device: arg("device", "desktop"),
  includeLocalPack: process.argv.includes("--local-pack"),
  targetDomain: arg("domain", "example.com"),
  languageCode: arg("hl", "ja"),
  locationCode: Number(arg("location-code", "2392")),
  locationName: arg("location", null),
  serpDepth: Number(arg("depth", "20")),
};

const browser = await launch({
  headless: !process.argv.includes("--headed"),
  humanize: true,
});
try {
  const result = await executeJob(browser, job);
  console.log(JSON.stringify({ job, result }, null, 2));
} catch (error) {
  console.error(
    error?.name === "CaptchaError"
      ? "captcha challenge hit — wait ~45 min before retrying from this IP"
      : `smoke failed: ${error?.message ?? error}`,
  );
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
