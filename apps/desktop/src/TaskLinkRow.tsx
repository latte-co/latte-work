import { Globe2 } from "lucide-react";
import { WebLink } from "./LinkHandling";

export function TaskLinkRow({ url, title }: { url: string; title: string }) {
  return (
    <WebLink
      href={url}
      className="task-info-file task-info-web"
      aria-label={title}
    >
      <Globe2 size={16} aria-hidden="true" />
      <span>
        <span className="task-info-resource-title" title={title}>
          {title}
        </span>
        <small>{url}</small>
      </span>
    </WebLink>
  );
}
