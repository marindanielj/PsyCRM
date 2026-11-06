import { brandPalette, contrastWithWhite as webContrast, readableBrand as webReadable } from '../../src/lib/brand'
import { contrastWithWhite, readableBrand } from './branding'

const samples = ['#4f46e5', '#ffffff', '#ffff00', '#fde68a', '#0e7490', '#ff5733', '#000000', '#7fffd4', '#d4a017', '#808080']

test('the web copy of the accent-colour rule agrees with the server on every sample, and the result is always readable', () => {
  for (const c of samples) {
    expect(webReadable(c), c).toBe(readableBrand(c))
    expect(webContrast(c), c).toBeCloseTo(contrastWithWhite(c), 6)
    expect(contrastWithWhite(readableBrand(c)), c).toBeGreaterThanOrEqual(4.5)
  }
  expect(readableBrand('#4f46e5')).toBe('#4f46e5') // an already readable colour is left alone
})

test('the palette has ten ordered shades around the accent, which becomes brand-600', () => {
  const lum = (h: string) => contrastWithWhite(h)
  for (const c of ['#4f46e5', '#0e7490', '#ffff00', '#808080']) {
    const p = brandPalette(c)
    expect(Object.keys(p)).toEqual(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'])
    expect(p['600']).toBe(readableBrand(c))
    for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/)
    // lighter shades first: contrast with white only grows from 50 to 900
    const order = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'].map((k) => lum(p[k]!))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  }
  expect(brandPalette('not a colour')['600']).toBe('#4f46e5') // falls back to the default
})
