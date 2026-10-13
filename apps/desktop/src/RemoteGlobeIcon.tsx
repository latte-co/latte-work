/** Shared meridians for the remote project badge and conversation marker. */
export function RemoteGlobeMark() {
  return (
    <>
      <circle cx="18" cy="18" r="4.5" />
      <ellipse cx="18" cy="18" rx="1.8" ry="4.5" />
      <path d="M13.5 18h9" />
    </>
  );
}

export function RemoteGlobeIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="12 12 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="远程对话"
    >
      <RemoteGlobeMark />
    </svg>
  );
}
