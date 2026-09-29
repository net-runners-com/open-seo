import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  getRankTrackingConfigs,
  getRunnerStatus,
} from "@/serverFunctions/rank-tracking";

// Shown on the rank tracking overview when at least one config uses the
// self-hosted runner: green while the runner heartbeats, warning when it has
// been silent for 30+ minutes (jobs would sit unclaimed).
export function RunnerStatusBanner({ projectId }: { projectId: string }) {
  const { data: configs } = useQuery({
    queryKey: ["rankTrackingConfigs", projectId],
    queryFn: () => getRankTrackingConfigs({ data: { projectId } }),
  });
  const hasRunnerConfig = configs?.some(
    (config) => config.provider === "runner",
  );

  const { data: status } = useQuery({
    queryKey: ["runnerStatus", projectId],
    queryFn: () => getRunnerStatus({ data: { projectId } }),
    enabled: hasRunnerConfig === true,
    refetchInterval: 60_000,
  });

  if (!hasRunnerConfig) return null;

  if (status && !status.stale) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
        <CheckCircle2 className="size-4 shrink-0" />
        <span>
          Runner online ({status.status}) — last seen{" "}
          {new Date(status.lastSeenAt).toLocaleTimeString()}
        </span>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning-content">
      <div className="flex items-center gap-2 font-medium text-warning">
        <AlertTriangle className="size-4 shrink-0" />
        <span>
          Runner offline — free rank checks are queued but nothing is collecting
          them
        </span>
      </div>
      <div className="mt-1 text-xs text-base-content/70">
        Start it with{" "}
        <code className="font-mono">
          node runner/cli.mjs --server {window.location.origin} --key &lt;oseo_…
          API key&gt;
        </code>{" "}
        (see runbooks/runner.md; self-host can use RUNNER_TOKEN instead).
      </div>
    </div>
  );
}
