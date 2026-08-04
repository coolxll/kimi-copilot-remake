/**
 * Chrome rejects tab API promises when a tab disappears between two async
 * operations. Browser implementations use a couple of different messages for
 * the same condition, so keep the detection in one place.
 */
export function isMissingTabError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no tab with id|could not find tab with id)/i.test(message);
}
