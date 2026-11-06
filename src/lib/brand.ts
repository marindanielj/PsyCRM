// Web side of a practice's branding. `readableBrand` mirrors server/lib/branding.ts (a test fails if they
// drift apart): the accent colour is darkened just enough that white text on it is readable.

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
export const DEFAULT_ACCENT = '#4f46e5'

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
export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
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

/** The ten shades the app's `brand-*` classes use, built around one accent (which becomes `brand-600`). */
export function brandPalette(accent: string): Record<string, string> {
  const base = readableBrand(HEX_COLOR.test(accent) ? accent.toLowerCase() : DEFAULT_ACCENT)
  const [h, s0, l600] = rgbToHsl(toRgb(base))
  const s = Math.max(0.25, Math.min(s0, 0.95)) // keep a washed-out or neon colour usable
  const at = (l: number) => hslToHex(h, s, Math.max(0.06, Math.min(0.98, l)))
  // 50 -> 500 walk from almost white down to just above the accent, so the shades are always in order
  const mix = (w: number) => at(0.96 - w * (0.96 - l600))
  return {
    '50': mix(0), '100': mix(0.12), '200': mix(0.3), '300': mix(0.5), '400': mix(0.72), '500': mix(0.88),
    '600': base, '700': at(l600 - 0.08), '800': at(l600 - 0.16), '900': at(l600 - 0.24),
  }
}

/** Put a practice's accent on the page (CSS variables the Tailwind theme reads); no colour restores the default. */
export function applyAccent(accent: string | null | undefined): void {
  const root = document.documentElement
  if (!accent || !HEX_COLOR.test(accent)) {
    for (const k of ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900']) root.style.removeProperty(`--color-brand-${k}`)
    return
  }
  for (const [k, v] of Object.entries(brandPalette(accent))) root.style.setProperty(`--color-brand-${k}`, v)
}

/** What the app shows as its name: the practice's branding name, else the location's. */
export function brandName(location: { name: string; branding: Record<string, unknown> } | null): string {
  const n = location?.branding?.name
  return typeof n === 'string' && n.trim() ? n.trim() : (location?.name ?? 'PsyCRM')
}

export function brandLogoUrl(location: { id: string; branding: Record<string, unknown> } | null): string | null {
  const v = location?.branding?.logoVersion
  return location && typeof v === 'string' && /^[0-9a-f]{8}$/.test(v) ? `/brand/${encodeURIComponent(location.id)}/logo?v=${v}` : null
}
