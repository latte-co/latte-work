/** Keep accessible text stable while the dots and label share one visual cycle. */
export function WorkingStatus({
  label,
  animated,
}: {
  label: string;
  animated: boolean;
}) {
  return (
    <div className="working" role="status" data-animated={animated}>
      <span className="working-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="working-label">{label.replace(/…$/, "")}</span>
    </div>
  );
}
