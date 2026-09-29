import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { RankTrackingDomainList } from "@/client/features/rank-tracking/RankTrackingDomainList";
import { RankTrackingConfigModal } from "@/client/features/rank-tracking/RankTrackingConfigModal";
import { RunnerStatusBanner } from "@/client/features/rank-tracking/RunnerStatusBanner";

export const Route = createFileRoute("/_project/p/$projectId/rank-tracking/")({
  component: RankTrackingIndex,
});

function RankTrackingIndex() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showConfigModal, setShowConfigModal] = useState(false);

  const invalidateConfigs = () => {
    void queryClient.invalidateQueries({
      queryKey: ["rankTrackingConfigs", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["rankTrackingConfigSummaries", projectId],
    });
  };

  return (
    <>
      <RunnerStatusBanner projectId={projectId} />
      <RankTrackingDomainList
        projectId={projectId}
        onAddDomain={() => setShowConfigModal(true)}
      />

      {showConfigModal && (
        <RankTrackingConfigModal
          projectId={projectId}
          existingConfig={null}
          onClose={() => setShowConfigModal(false)}
          onConfigCreated={invalidateConfigs}
          onSaved={(createdConfigId) => {
            setShowConfigModal(false);
            invalidateConfigs();
            if (createdConfigId) {
              void navigate({
                to: "/p/$projectId/rank-tracking/$configId",
                params: { projectId, configId: createdConfigId },
              });
            }
          }}
        />
      )}
    </>
  );
}
