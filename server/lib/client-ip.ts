/**
 * Best-effort client IP from X-Forwarded-For. Each proxy APPENDS the address it
 * received the request from, so the left-most entries are whatever the client
 * chose to send (spoofable) and only the right-most entry — the one our own
 * load balancer added — can be trusted. `trustedHops` is how many proxies sit in
 * front of the app (1 = just the AWS load balancer), and the address we want is
 * that many entries from the right. With no header (a direct connection, dev) we
 * return 'unknown', so every such request shares one bucket instead of bypassing
 * the login throttle.
 */
export function clientIp(
  c: { req: { header: (name: string) => string | undefined } },
  trustedHops = 1,
): string {
  const parts = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return 'unknown'
  return parts[Math.max(0, parts.length - trustedHops)] ?? 'unknown'
}
