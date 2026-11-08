/** A practice's look: the name shown in the app, one accent colour, and a logo. */

export interface Branding {
  /** Shown instead of the location name in the app and on client pages; null = use the practice name. */
  name: string | null
  /** The accent colour, `#rrggbb`; null = the default. */
  color: string | null
  /** A short fingerprint of the logo (for cache-busting its URL); null = no logo. */
  logoVersion: string | null
}

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
export const MAX_LOGO_BYTES = 300 * 1024
export const BRAND_NAME_MAX = 80

export type LogoType = 'image/png' | 'image/jpeg' | 'image/webp'

/** What a stored `locations.branding` object means (any other keys are left alone elsewhere). */
export function normalizeBranding(raw: unknown): Branding {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, BRAND_NAME_MAX) : null
  const color = typeof r.color === 'string' && HEX_COLOR.test(r.color) ? r.color.toLowerCase() : null
  const logoVersion = typeof r.logoVersion === 'string' && /^[0-9a-f]{8}$/.test(r.logoVersion) ? r.logoVersion : null
  return { name, color, logoVersion }
}

/**
 * The type of an image from its first bytes, never from what the uploader claims. Only PNG, JPEG and
 * WebP are accepted: SVG can carry scripts, so it is refused.
 */
export function detectLogoType(buf: Uint8Array): LogoType | null {
  const is = (...bytes: number[]) => bytes.every((b, i) => buf[i] === b)
  if (buf.length > 12 && is(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (buf.length > 12 && is(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (buf.length > 12 && is(0x52, 0x49, 0x46, 0x46) && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}

/** Decode a `data:image/...;base64,` URL into bytes (strictly: no other form is accepted). */
export function decodeDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!m || m[1]!.length > Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 8) return null
  return Buffer.from(m[1]!, 'base64')
}

/** The URL of a practice's logo, or null when it has none. */
export const logoUrl = (locationId: string, b: Branding): string | null => (b.logoVersion ? `/brand/${encodeURIComponent(locationId)}/logo?v=${b.logoVersion}` : null)

// ---- colour: an accent that always reads with white text on it -------------------------------

function toRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
/** WCAG contrast of white text on this colour. */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(toRgb(hex)) + 0.05)
}
function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return [h * 60, s, l]
}
function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
/** The chosen colour, darkened just enough that white text on it is readable (contrast 4.5). Already readable colours are returned unchanged. */
export function readableBrand(hex: string): string {
  if (contrastWithWhite(hex) >= 4.5) return hex
  const [h, s, l0] = rgbToHsl(toRgb(hex))
  let l = l0
  let out = hex
  while (contrastWithWhite(out) < 4.5 && l > 0.04) {
    l -= 0.01
    out = hslToHex(h, s, l)
  }
  return out
}
