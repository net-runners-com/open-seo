// Data-source picker for a rank tracking config: DataForSEO (paid credits)
// or the self-hosted runner (free), with the runner-only local pack toggle.
export function RunnerProviderFields(props: {
  provider: "dataforseo" | "runner";
  onProviderChange: (provider: "dataforseo" | "runner") => void;
  trackLocalPack: boolean;
  onTrackLocalPackChange: (value: boolean) => void;
}) {
  const { provider, trackLocalPack } = props;
  return (
    <>
      <div className="form-control">
        <label className="label">
          <span className="label-text font-medium">Data Source</span>
        </label>
        <select
          className="select select-bordered w-full"
          value={provider}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "dataforseo" || value === "runner") {
              props.onProviderChange(value);
            }
          }}
        >
          <option value="dataforseo">DataForSEO API (credits)</option>
          <option value="runner">Self-hosted runner (free)</option>
        </select>
        {provider === "runner" && (
          <>
            <label className="label cursor-pointer justify-start gap-2 mt-1">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={trackLocalPack}
                onChange={(e) => props.onTrackLocalPackChange(e.target.checked)}
              />
              <span className="label-text text-sm">
                Also track the Google local pack (MEO)
              </span>
            </label>
            <div className="mt-1 text-xs text-base-content/50">
              Requires the bundled runner CLI polling this workspace — see
              runbooks/runner.md
            </div>
          </>
        )}
      </div>
    </>
  );
}
