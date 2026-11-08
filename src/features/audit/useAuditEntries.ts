import { useCallback, useEffect, useRef, useState } from 'react'
import { type AuditEntry, type AuditFilters, api } from '../../lib/api'

/** Loads the audit log page by page for the current filters; changing the filters
 *  restarts from the newest entry. Stale responses (a slower, older request) are
 *  ignored. */
export function useAuditEntries(loc: string | undefined, filters: AuditFilters, pageSize = 50) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const generation = useRef(0)
  const key = JSON.stringify(filters)

  useEffect(() => {
    if (!loc) return
    const gen = ++generation.current
    setStatus('loading')
    api
      .auditLog(loc, { ...filters, limit: pageSize })
      .then((r) => {
        if (gen !== generation.current) return
        setEntries(r.entries)
        setNextBefore(r.nextBefore)
        setStatus('ready')
      })
      .catch(() => gen === generation.current && setStatus('error'))
    // `key` stands in for the filters object (new identity on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, key, pageSize])

  const loadMore = useCallback(async () => {
    if (!loc || nextBefore === null || loadingMore) return
    const gen = generation.current
    setLoadingMore(true)
    try {
      const r = await api.auditLog(loc, { ...filters, before: nextBefore, limit: pageSize })
      if (gen !== generation.current) return
      setEntries((prev) => [...prev, ...r.entries])
      setNextBefore(r.nextBefore)
    } finally {
      setLoadingMore(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, key, nextBefore, loadingMore, pageSize])

  return { entries, status, hasMore: nextBefore !== null, loadMore, loadingMore }
}
