export const POLICY = {
  /** Max transient retries before GIVE_UP. */
  maxAttempts: 6,
  /** Base for exponential backoff. */
  baseBackoffMs: 60_000,
  /** Backoff cap. */
  maxBackoffMs: 30 * 60_000,
  /** Jitter as a fraction of computed delay (e.g. 0.2 → ±20%). */
  jitter: 0.2,
  /** A device must check in at least this often to stay non-OFFLINE. */
  heartbeatThresholdMs: 60_000,
  /**
   * If a device has been in APPLYING for longer than this without an
   * acknowledging check-in, the sweep treats it as a transient failure.
   */
  applyingTimeoutMs: 90_000,
  /** Background sweep interval. */
  sweepIntervalMs: 10_000,
} as const;

export function nextRetryAt(
  failureCount: number,
  now: number,
  rng: () => number = Math.random,
): number {
  const exp = Math.min(
    POLICY.baseBackoffMs * 2 ** Math.max(0, failureCount - 1),
    POLICY.maxBackoffMs,
  );
  const delta = exp * POLICY.jitter * (rng() * 2 - 1);
  return now + Math.round(exp + delta);
}

export function shouldGiveUp(failureCount: number): boolean {
  return failureCount >= POLICY.maxAttempts;
}
