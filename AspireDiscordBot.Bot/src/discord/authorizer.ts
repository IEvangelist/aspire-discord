export function isUserAllowed(userId: string, allowedUserIds: ReadonlySet<string>): boolean {
  return allowedUserIds.size === 0 || allowedUserIds.has(userId);
}
