import { ImagePlus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { PageSpinner } from '../../components/ui/spinner'
import { ApiError, type Branding, api } from '../../lib/api'
import { DEFAULT_ACCENT, HEX_COLOR, brandPalette, contrastWithWhite, readableBrand } from '../../lib/brand'
import { useTenant } from '../../state/location'

const MAX_LOGO = 300 * 1024

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** Settings → Branding: the name, accent colour and logo this practice shows in the app and to its clients. */
export function BrandingSettingsPage() {
  const { current, refresh } = useTenant()
  const loc = current?.id

  const [saved, setSaved] = useState<Branding | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!loc) return
    let live = true
    setSaved(null)
    api.branding.get(loc).then((r) => {
      if (!live) return
      setSaved(r.branding)
      setName(r.branding.name ?? '')
      setColor(r.branding.color)
    }).catch(() => live && setError('Could not load the branding.'))
    return () => { live = false }
  }, [loc])

  if (!loc || !saved) return error ? <p role="alert" className="p-6 text-sm text-rose-700">{error}</p> : <PageSpinner />

  const dirty = name.trim() !== (saved.name ?? '') || (color ?? null) !== saved.color
  const accent = color ?? DEFAULT_ACCENT
  const shown = readableBrand(accent)
  const darkened = shown.toLowerCase() !== accent.toLowerCase()
  const palette = brandPalette(accent)
  const preview = name.trim() || current?.name || 'Your practice'

  /** `logoOnly`: a picture change must not throw away a name or colour the person is still typing. */
  async function run(fn: () => Promise<Branding>, ok: string, logoOnly = false) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const b = await fn()
      if (logoOnly) {
        setSaved((cur) => (cur ? { ...cur, logoVersion: b.logoVersion, logoUrl: b.logoUrl } : b))
      } else {
        setSaved(b)
        setName(b.name ?? '')
        setColor(b.color)
      }
      await refresh()
      setNote(ok)
    } catch (e) {
      const code = e instanceof ApiError ? e.message : ''
      setError(code === 'logo_too_large' ? 'That picture is too large (300 KB at most).' : code === 'invalid_logo' ? 'Use a PNG, JPEG or WebP picture.' : 'Could not save. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function pickLogo(f: File | undefined) {
    if (!f) return
    if (f.size > MAX_LOGO) return setError('That picture is too large (300 KB at most).')
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return setError('Use a PNG, JPEG or WebP picture.')
    await run(async () => (await api.branding.uploadLogo(loc!, await readAsDataUrl(f))).branding, 'Logo updated.', true)
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <h1 className="text-lg font-semibold text-slate-900">Branding</h1>
      <p className="mt-1 text-sm text-slate-600">How this practice looks in the app and to its clients: on the signing and registration pages, and in the emails they receive.</p>

      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_16rem]">
        <div className="space-y-6">
          <div>
            <Label htmlFor="b-name">Name shown</Label>
            <Input id="b-name" value={name} maxLength={80} placeholder={current?.name ?? 'Practice name'} onChange={(e) => setName(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Leave it empty to use the practice name. Legal documents still use the practice name from <em>Practice</em>.</p>
          </div>

          <div>
            <Label htmlFor="b-color">Accent colour</Label>
            <div className="flex flex-wrap items-center gap-3">
              <input id="b-color" type="color" aria-label="Accent colour" value={HEX_COLOR.test(accent) ? accent : DEFAULT_ACCENT} onChange={(e) => setColor(e.target.value)} className="h-10 w-14 cursor-pointer rounded-lg border border-slate-200 bg-white p-1" />
              <Input aria-label="Accent colour (hex)" className="w-32 font-mono" value={color ?? ''} placeholder={DEFAULT_ACCENT} maxLength={7} onChange={(e) => setColor(e.target.value === '' ? null : e.target.value)} />
              {color && <Button type="button" variant="ghost" size="sm" onClick={() => setColor(null)}>Use the default</Button>}
            </div>
            {color !== null && !HEX_COLOR.test(color) && <p role="alert" className="mt-1 text-xs font-medium text-rose-600">Use a colour like #0e7490.</p>}
            {darkened && <p className="mt-1 text-xs text-amber-700">Buttons use a slightly darker shade ({shown}) so the white text stays readable.</p>}
            <div className="mt-3 flex overflow-hidden rounded-lg" aria-hidden="true">
              {Object.values(palette).map((c, i) => <span key={i} className="h-5 flex-1" style={{ background: c }} />)}
            </div>
          </div>

          <div>
            <Label>Logo</Label>
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-slate-200 bg-white p-1">
                {saved.logoUrl ? <img src={saved.logoUrl} alt="Current logo" className="max-h-full max-w-full object-contain" /> : <ImagePlus className="h-6 w-6 text-slate-300" aria-hidden />}
              </div>
              <div className="space-y-1">
                <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload logo" onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = '' }} />
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => file.current?.click()}>{saved.logoUrl ? 'Replace logo' : 'Upload logo'}</Button>
                  {saved.logoUrl && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => (await api.branding.removeLogo(loc)).branding, 'Logo removed.', true)}><Trash2 className="h-4 w-4" /> Remove</Button>}
                </div>
                <p className="text-xs text-slate-500">PNG, JPEG or WebP, up to 300 KB. A square or wide picture on a transparent or white background works best.</p>
              </div>
            </div>
          </div>

          {error && <p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}
          {note && <p role="status" className="text-sm font-medium text-emerald-700">{note}</p>}
          <div className="flex gap-2">
            <Button disabled={!dirty || busy || (color !== null && !HEX_COLOR.test(color))} onClick={() => void run(async () => (await api.branding.save(loc, { name: name.trim() || null, color: color && HEX_COLOR.test(color) ? color : null })).branding, 'Saved.')}>{busy ? 'Saving…' : 'Save'}</Button>
            <Button variant="outline" disabled={!dirty || busy} onClick={() => { setName(saved.name ?? ''); setColor(saved.color) }}>Discard changes</Button>
          </div>
        </div>

        <aside aria-label="Preview" className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preview</div>
          <div className="rounded-xl bg-slate-900 p-4">
            <div className="flex items-center gap-2.5">
              {saved.logoUrl ? <img src={saved.logoUrl} alt="" className="h-8 w-8 rounded-lg bg-white object-contain p-0.5" /> : <span className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: shown }}>{preview.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}</span>}
              <span className="truncate text-[15px] font-semibold text-white">{preview}</span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <button type="button" tabIndex={-1} className="rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ background: shown }}>Sign and continue</button>
            <p className="mt-2 text-xs text-slate-500">Contrast with white text: {contrastWithWhite(shown).toFixed(1)}:1</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
