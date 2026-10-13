import { RemoteGlobeMark } from "./RemoteGlobeIcon";

export function RemoteProjectIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="远程项目"
    >
      <title>远程项目</title>
      <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.67.9l.81 1.2A2 2 0 0 0 12.1 6H20a2 2 0 0 1 2 2v3M2 10h20" />
      <g className="project-remote-globe" strokeWidth="1.5">
        <RemoteGlobeMark />
      </g>
    </svg>
  );
}
