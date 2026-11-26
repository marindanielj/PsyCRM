import { HTTPException } from 'hono/http-exception'
import type { Context } from 'hono'

/** The only calls the app makes to the video service. A closed set, so the log line below can never carry free text. */
export type VideoOperation = 'createMeeting' | 'createAttendee' | 'endMeeting'

/** The video service (Chime) refused or could not be reached. Carries the operation, never anything about a client. */
export class VideoProviderError extends Error {
  constructor(readonly operation: VideoOperation, readonly reason: string) {
    super(`video provider failed: ${operation} (${reason})`)
    this.name = 'VideoProviderError'
  }
}

/**
 * Run one call to the video service. A failure is logged with WHICH call and Amazon's error name (for example
 * AccessDeniedException or a network error), because without it a deploy problem is invisible; never an id, a name
 * or the message text, which could carry client data. The caller gets a VideoProviderError.
 */
export async function viaProvider<T>(operation: VideoOperation, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    const e = err as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null
    // Letters, digits and . _ - only, and short: an error name like AccessDeniedException, a code, an HTTP status. Never message text.
    const clean = (v: unknown) => String(v).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60)
    const reason = [e?.name, e?.code, e?.$metadata?.httpStatusCode].filter((v) => typeof v === 'string' || typeof v === 'number').map(clean).filter(Boolean).join(' ') || 'unknown'
    console.error('video provider failed', operation, reason)
    throw new VideoProviderError(operation, reason)
  }
}

/** Error handler for the video routes: a provider failure is a clear 502 the pages can explain; the rest is as everywhere. */
export function videoErrorHandler(err: Error, c: Context): Response {
  if (err instanceof VideoProviderError) return c.json({ error: 'video_unavailable' }, 502)
  if (err instanceof HTTPException) return err.getResponse()
  console.error('request failed', c.req.method, (err as { code?: unknown } | null)?.code ?? 'unknown')
  return c.json({ error: 'internal error' }, 500)
}
