type DragPayload = {
  types?: ArrayLike<string> | null;
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string }> | null;
};

// A file drag does not always advertise itself through `types`: over
// editable targets WebKit may deliver a drop whose payload only carries
// `files` or `items` entries. Detect every shape so drop zones never miss
// a file drag, while text-only drags stay ignored.
export function dragHasFiles(transfer: DragPayload | null | undefined) {
  if (!transfer) return false;
  if (Array.from(transfer.types ?? []).includes("Files")) return true;
  if ((transfer.files?.length ?? 0) > 0) return true;
  return Array.from(transfer.items ?? []).some((item) => item.kind === "file");
}

// HTML5 file drops are enabled in the main WebView. Registered on the
// capture phase so it runs before component handlers: never navigate away
// from the app or let a dropped file name land in an editable field when a
// file misses the composer (including settings/no-task views).
export function preventFileNavigation(event: DragEvent) {
  if (dragHasFiles(event.dataTransfer)) event.preventDefault();
}
