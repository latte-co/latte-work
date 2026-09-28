export async function copyText(text: string): Promise<void> {
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.className = "appearance-copy-buffer";
  field.setAttribute("aria-hidden", "true");
  (focused?.closest('[role="dialog"]') ?? document.body).appendChild(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    copied = document.execCommand?.("copy") ?? false;
  } catch {
    // Modern clipboard is a fallback when the WebView disables legacy copying.
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
  if (!copied) await navigator.clipboard.writeText(text);
}
