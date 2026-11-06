import { cn } from '../../lib/utils'
import { label } from '../../lib/clinical-vocab'

/** Multi-select chips for a closed vocabulary (MSE values, risk factors, interventions…). */
export function ChipGroup({
  options,
  value,
  onChange,
  disabled,
  exclusive,
  invalid,
  ariaLabel,
}: {
  options: readonly string[]
  value: readonly string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  /** Options that cannot be combined with any other (e.g. "none" among the risk actions). */
  exclusive?: readonly string[]
  invalid?: boolean
  ariaLabel?: string
}) {
  function toggle(opt: string) {
    if (disabled) return
    if (value.includes(opt)) return onChange(value.filter((v) => v !== opt))
    if (exclusive?.includes(opt)) return onChange([opt])
    onChange([...value.filter((v) => !exclusive?.includes(v)), opt])
  }
  return (
    <div role="group" aria-label={ariaLabel} className={cn('flex flex-wrap gap-1.5', invalid && 'rounded-lg ring-2 ring-rose-300 ring-offset-2')}>
      {options.map((opt) => {
        const on = value.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => toggle(opt)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
            )}
          >
            {label(opt)}
          </button>
        )
      })}
    </div>
  )
}

/** A single-choice row of buttons (radio semantics). `value` null = nothing chosen yet. */
export function ChoiceGroup({
  options,
  value,
  onChange,
  disabled,
  invalid,
  ariaLabel,
  tone,
}: {
  options: readonly string[]
  value: string | null
  onChange: (next: string) => void
  disabled?: boolean
  invalid?: boolean
  ariaLabel: string
  /** Optional per-option colour classes for the selected state (the risk level). */
  tone?: (option: string) => string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('flex flex-wrap gap-1.5', invalid && 'rounded-lg ring-2 ring-rose-300 ring-offset-2')}>
      {options.map((opt) => {
        const on = value === opt
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              on ? (tone?.(opt) ?? 'border-brand-600 bg-brand-600 text-white') : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
            )}
          >
            {label(opt)}
          </button>
        )
      })}
    </div>
  )
}
