/**
 * Web copy of the labels and fixed texts of the public page in server/lib/public-page.ts (kept here so the bundle stays
 * frontend-only). server/lib/public-page-mirror.test.ts fails if the two drift apart.
 */
import type { PageDay, PageMode, PageSlot } from './api'

export const DAYS: readonly PageDay[] = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
export const DAY_LABEL: Record<PageDay, string> = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado' }
export const SLOTS: readonly PageSlot[] = ['manana', 'tarde']
export const SLOT_LABEL: Record<PageSlot, string> = { manana: 'Mañana', tarde: 'Tarde' }
export const MODES: readonly PageMode[] = ['presencial', 'virtual']
export const MODE_LABEL: Record<PageMode, string> = { presencial: 'Presencial', virtual: 'Virtual' }

/** Added to the form automatically while the practice does not accept insurance. */
export const NO_INSURANCE_ACK = 'Entiendo que no se aceptan planes médicos.'
export const DEFAULT_ACKS: readonly string[] = ['Leí las preguntas frecuentes de esta página.', 'Vi las tarifas.']

export const LIMITS = { headline: 120, subheadline: 240, about: 1500, serviceTitle: 80, serviceText: 400, services: 8, plan: 60, plans: 30, insuranceNote: 500, question: 200, answer: 1200, faq: 20, hours: 400, location: 400, intro: 300, ack: 200, acks: 5 } as const

export const slugOk = (s: string): boolean => /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(s)
