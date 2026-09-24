import type { ItemKey } from "../../lib/access-policy";

export const REPORT_SORT_KEY = "REPORT#P1#v1";
export const HISTORY_SORT_PREFIX = "SESSION#";

export function sessionMetaKey(sessionId: string): ItemKey {
  return { PK: `SESSION#${sessionId}`, SK: "META" };
}

export function reportKey(sessionId: string): ItemKey {
  return { PK: `SESSION#${sessionId}`, SK: REPORT_SORT_KEY };
}

/** Sorts a user's sessions by creation time; the session ID keeps keys unique. */
export function historySortKey(createdAt: string, sessionId: string): string {
  return `${HISTORY_SORT_PREFIX}${createdAt}#${sessionId}`;
}

export function historyKey(userId: string, historySk: string): ItemKey {
  return { PK: `USER#${userId}`, SK: historySk };
}
