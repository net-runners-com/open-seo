const RESULTS_CHUNK = 50;

export function createApiClient({ serverOrigin, token }) {
  const origin = serverOrigin.replace(/\/$/, "");

  async function call(path, init = {}) {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`runner api ${path} failed: ${response.status} ${body}`);
    }
    return response;
  }

  return {
    async claimJobs(limit) {
      const response = await call(`/api/runner/jobs?limit=${limit}`);
      const { jobs } = await response.json();
      return jobs;
    },
    async submitResults(results) {
      let accepted = 0;
      let rejected = 0;
      for (let i = 0; i < results.length; i += RESULTS_CHUNK) {
        const chunk = results.slice(i, i + RESULTS_CHUNK);
        const response = await call("/api/runner/results", {
          method: "POST",
          body: JSON.stringify({ results: chunk }),
        });
        const outcome = await response.json();
        accepted += outcome.accepted ?? 0;
        rejected += outcome.rejected ?? 0;
      }
      return { accepted, rejected };
    },
    async heartbeat(status) {
      await call("/api/runner/heartbeat", {
        method: "POST",
        body: JSON.stringify({ status }),
      });
    },
  };
}
