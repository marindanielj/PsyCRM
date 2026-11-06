/** A rendered document in a sandboxed frame: no scripts run, whatever the template says. */
export function PreviewFrame({ html, title }: { html: string | null; title: string }) {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html ?? ''}
      className="h-[70vh] min-h-[420px] w-full rounded-lg border border-slate-200 bg-white"
    />
  )
}
