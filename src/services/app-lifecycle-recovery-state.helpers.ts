export function isRecoveryCompensationInFlight(
  activeTicketId: string | null | undefined,
  requestedTicketId?: string,
): boolean {
  if (!activeTicketId) return false;
  if (!requestedTicketId) return true;
  return activeTicketId === requestedTicketId;
}

export function isHeavyRecoveryInCooldown(
  lastHeavyRecoveryAt: number | null | undefined,
  nowMs: number,
  windowMs: number,
): boolean {
  if (!lastHeavyRecoveryAt) return false;
  return nowMs - lastHeavyRecoveryAt < windowMs;
}
