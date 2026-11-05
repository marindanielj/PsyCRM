import { clientIp } from './client-ip'

const req = (xff?: string) => ({ req: { header: (n: string) => (n === 'x-forwarded-for' ? xff : undefined) } })

test('takes the address our own proxy appended (right-most), not the spoofable left side', () => {
  expect(clientIp(req('1.2.3.4'))).toBe('1.2.3.4')
  expect(clientIp(req('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9') // client forged 6.6.6.6
  expect(clientIp(req('6.6.6.6, 7.7.7.7, 203.0.113.9'))).toBe('203.0.113.9')
})

test('trustedHops counts proxies in front of the app', () => {
  expect(clientIp(req('203.0.113.9, 10.0.0.5'), 2)).toBe('203.0.113.9')
  expect(clientIp(req('only-one'), 3)).toBe('only-one') // fewer entries than hops
})

test('no header (or an empty one) shares a single "unknown" bucket', () => {
  expect(clientIp(req())).toBe('unknown')
  expect(clientIp(req(''))).toBe('unknown')
  expect(clientIp(req(' , '))).toBe('unknown')
})
