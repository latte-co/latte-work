import { useState } from "react";
import { Link2 } from "lucide-react";
import { WebLink } from "./LinkHandling";
import { webLink } from "./browserLinks";

function SiteIcon({ origin }: { origin: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return (
    <span className="task-info-site-icon" aria-hidden="true">
      {state !== "ready" && <Link2 size={16} />}
      {state !== "failed" && (
        <img
          src={`${origin}/favicon.ico`}
          alt=""
          width={16}
          height={16}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={state === "ready" ? "is-ready" : undefined}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      )}
    </span>
  );
}

export function TaskLinkRow({ url, title }: { url: string; title: string }) {
  const address = webLink(url);
  const parsed = address ? new URL(address) : null;
  const compact = parsed
    ? `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`
    : url;
  const label = title.trim();
  const hasTitle =
    !!label &&
    ![url, address, compact, parsed?.hostname, parsed?.host].includes(label);
  const display = hasTitle ? label : compact;
  return (
    <WebLink
      href={url}
      className="task-info-file task-info-web"
      aria-label={display}
    >
      {parsed ? (
        <SiteIcon key={parsed.origin} origin={parsed.origin} />
      ) : (
        <Link2 size={16} aria-hidden="true" />
      )}
      <span>
        <span className="task-info-resource-title" title={display}>
          {display}
        </span>
        {hasTitle && <small>{compact}</small>}
      </span>
    </WebLink>
  );
}
