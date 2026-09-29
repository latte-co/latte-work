/** Keep the label stable; only the small three-dot indicator moves. */
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
      <span>{label.replace(/…$/, "")}</span>
    </div>
  );
}
