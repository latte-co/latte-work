/** Refresh preserves navigation; only an explicit selection opens a conversation. */
export function sessionAfterRefresh(
  current: string,
  requested: string | null,
  draft: boolean,
): string {
  if (draft) return "";
  return requested ?? current;
}
