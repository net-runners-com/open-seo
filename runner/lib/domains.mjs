// Shared hostname matching: exact domain or any subdomain of it.
export function hostnameMatches(hostname, targetDomain) {
  const host = hostname.toLowerCase();
  const target = targetDomain.toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

export function isGoogleHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "google.com" ||
    host.endsWith(".google.com") ||
    /(^|\.)google\.[a-z.]+$/.test(host)
  );
}
