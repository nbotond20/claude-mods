import { useId, useState, type ReactNode } from 'react';
import { Button, Card, Input, Switch } from '@loam/ui-web';

/** A titled group of settings rows in one card. */
export function Group({ title, count, description, actions, children, id }: { title: string; count?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="flex flex-col gap-3" id={id} aria-label={title}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-baseline gap-2 text-15 font-semibold">
            {title}
            {count !== undefined && <span className="text-13 font-normal tabular-nums text-ink-3">{count}</span>}
          </h2>
          {description && <p className="mt-0.5 max-w-[42rem] text-13 text-ink-3">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <Card className="flex flex-col divide-y divide-line overflow-hidden p-0">{children}</Card>
    </section>
  );
}

/**
 * One setting: label and explanation on the left, the control on the right.
 * `stack` puts a wide control (list, textarea) under the label instead.
 */
export function Row({ label, hint, children, stack = false, htmlFor, disabled = false }: { label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean; htmlFor?: string; disabled?: boolean }) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className={`flex flex-col gap-3 px-5 transition-opacity ${hint || stack ? 'py-4' : 'py-3'} ${stack ? '' : 'tablet:flex-row tablet:items-center tablet:justify-between tablet:gap-8'} ${disabled ? 'opacity-50' : ''}`} aria-disabled={disabled || undefined}>
      <div className="min-w-0 tablet:max-w-[30rem]">
        <Label htmlFor={htmlFor} className="block text-13 font-medium text-ink">
          {label}
        </Label>
        {hint && <div className="mt-0.5 text-12 leading-5 text-ink-3">{hint}</div>}
      </div>
      <div className={stack ? 'min-w-0' : 'flex shrink-0 items-center gap-2 tablet:justify-end'}>{children}</div>
    </div>
  );
}

/** Content inside a group that is not a label/control pair (lists, tables, notices). */
export function Block({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}

/** Right-hand controls share one width so their edges line up across rows. */
export const CONTROL_W = 'w-44';

/** A number input with its unit inside the field. */
export function UnitInput({ value, onChange, unit, className = CONTROL_W, size = 'sm', ...rest }: { value: number | string; onChange: (v: string) => void; unit?: string; className?: string; size?: 'xs' | 'sm'; step?: number; min?: number; max?: number; id?: string; placeholder?: string; disabled?: boolean; error?: boolean; 'aria-label'?: string }) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <Input type="number" size={size} wrapperClassName="w-full" className={`w-full text-right tabular-nums ${unit ? (size === 'xs' ? 'pr-6' : 'pr-9') : ''}`} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
      {unit && <span className={`pointer-events-none absolute inset-y-0 flex items-center text-12 text-ink-3 ${size === 'xs' ? 'right-2' : 'right-3'}`}>{unit}</span>}
    </span>
  );
}

export function NumberRow({ label, hint, value, onChange, unit, step = 1, min = 0, max, disabled }: { label: string; hint?: ReactNode; value: number; onChange: (v: number) => void; unit?: string; step?: number; min?: number; max?: number; disabled?: boolean }) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id} disabled={disabled}>
      <UnitInput id={id} unit={unit} value={Number.isFinite(value) ? value : ''} step={step} min={min} max={max} disabled={disabled} error={!Number.isFinite(value)} onChange={(v) => onChange(v === '' ? NaN : Number(v))} />
    </Row>
  );
}

export function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Row label={label} hint={hint} disabled={disabled}>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
    </Row>
  );
}

/** An editable list of strings (paths, emails): one input per entry, commits on blur. */
export function ListRow({ label, hint, value, onChange, placeholder, addLabel = 'Add', mono = true, disabled }: { label: string; hint?: ReactNode; value: string[]; onChange: (v: string[]) => void; placeholder?: string; addLabel?: string; mono?: boolean; disabled?: boolean }) {
  // A freshly added row stays until it is filled in or removed.
  const [draft, setDraft] = useState(false);
  const rows = draft ? [...value, ''] : value;
  const commit = (i: number, text: string) => {
    const v = text.trim();
    if (i === value.length) {
      setDraft(false);
      if (v) onChange([...value, v]);
    } else if (v !== value[i]) onChange(v ? value.map((x, j) => (j === i ? v : x)) : value.filter((_, j) => j !== i));
  };
  return (
    <Row label={label} hint={hint} stack disabled={disabled}>
      <div className="flex flex-col gap-2">
        {rows.map((item, i) => (
          <div key={`${i}:${item}`} className="flex items-center gap-2">
            <Input
              size="sm"
              wrapperClassName="min-w-0 flex-1"
              className={`w-full ${mono ? 'font-mono text-12' : ''}`}
              defaultValue={item}
              placeholder={placeholder}
              autoFocus={i === value.length}
              spellCheck={false}
              disabled={disabled}
              aria-label={`${label} ${i + 1}`}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              onBlur={(e) => commit(i, e.target.value)}
            />
            <Button size="sm" variant="ghost" iconOnly leadingIcon="trash" aria-label={`Remove ${item || 'entry'}`} disabled={disabled} onClick={() => (i === value.length ? setDraft(false) : onChange(value.filter((_, j) => j !== i)))} />
          </div>
        ))}
        <div>
          <Button size="sm" variant="ghost" leadingIcon="plus" className="-ml-2" disabled={disabled || draft} onClick={() => setDraft(true)}>{addLabel}</Button>
        </div>
      </div>
    </Row>
  );
}

/** Small uppercase-free status text with a colored dot. */
export function Status({ tone, children }: { tone: 'good' | 'warn' | 'neutral' | 'danger'; children: ReactNode }) {
  const dot = { good: 'bg-good', warn: 'bg-warn', neutral: 'bg-ink-3', danger: 'bg-danger' }[tone];
  return (
    <span className="inline-flex items-center gap-1.5 text-12 text-ink-2">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {children}
    </span>
  );
}
