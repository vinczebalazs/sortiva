import type { ReactNode } from 'react'

export function Page(props: { label?: string; title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="ui-page">
      <div className="ui-row" style={{ alignItems: 'flex-end' }}>
        <div>
          {props.label && <p className="ui-label">{props.label}</p>}
          <h1 className="ui-title" style={{ marginTop: props.label ? 10 : 0 }}>{props.title}</h1>
          {props.subtitle && <p className="ui-subtitle">{props.subtitle}</p>}
        </div>
        {props.actions && <div className="ui-row" style={{ marginLeft: 'auto', gap: 10 }}>{props.actions}</div>}
      </div>
      {props.children}
    </main>
  )
}

export function Card({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="ui-card">
      {(title || aside) && (
        <div className="ui-row" style={{ marginBottom: 14 }}>
          {title && <h2 className="ui-heading" style={{ margin: 0 }}>{title}</h2>}
          {aside && <span style={{ marginLeft: 'auto' }}>{aside}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stack({ children, gap }: { children: ReactNode; gap?: number }) {
  return <div className="ui-stack" style={gap ? { gap } : undefined}>{children}</div>
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="ui-row">{children}</div>
}

export function Button(props: { children: ReactNode; primary?: boolean; ghost?: boolean; disabled?: boolean; onClick?: () => void; type?: 'button' | 'submit' }) {
  return (
    <button
      className="ui-button"
      data-primary={props.primary || undefined}
      data-ghost={props.ghost || undefined}
      disabled={props.disabled}
      onClick={props.onClick}
      type={props.type ?? 'button'}
    >
      {props.children}
    </button>
  )
}

export function Tag({ tone, children }: { tone?: 'primary' | 'success'; children: ReactNode }) {
  return <span className="ui-tag" data-tone={tone}>{children}</span>
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'critical'; children: ReactNode }) {
  return (
    <div className="ui-banner" data-tone={tone} role={tone === 'critical' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function Progress({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <div className="ui-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  )
}

const tick = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export type ChecklistItem = { label: string; state: 'done' | 'active' | 'todo'; detail?: string; aside?: string }

export function Checklist({ items }: { items: ChecklistItem[] }) {
  return (
    <ul className="ui-checklist">
      {items.map((item, i) => (
        <li key={item.label}>
          <span className="ui-check" data-state={item.state}>{item.state === 'done' ? tick : i + 1}</span>
          <div>
            <span className="ui-check-label" data-state={item.state}>{item.label}</span>
            {item.detail && <p className="ui-check-detail">{item.detail}</p>}
          </div>
          {item.aside && <span className="ui-check-aside">{item.aside}</span>}
        </li>
      ))}
    </ul>
  )
}

type FieldProps = { id: string; label: string; error?: string; hint?: string }

export function TextField(props: FieldProps & { value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <div className="ui-field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.multiline ? (
        <textarea id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-invalid={Boolean(props.error)} />
      ) : (
        <input id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-invalid={Boolean(props.error)} />
      )}
      {props.hint && <span className="ui-field-hint">{props.hint}</span>}
      {props.error && <span className="ui-field-error">{props.error}</span>}
    </div>
  )
}

export function Select(props: FieldProps & { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="ui-field">
      <label htmlFor={props.id}>{props.label}</label>
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {props.hint && <span className="ui-field-hint">{props.hint}</span>}
      {props.error && <span className="ui-field-error">{props.error}</span>}
    </div>
  )
}

export function Choices(props: { name: string; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string; description?: string }[] }) {
  return (
    <fieldset className="ui-field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ marginBottom: 7 }}>{props.label}</legend>
      <div className="ui-choices">
        {props.options.map((o) => (
          <label key={o.value} className="ui-choice" data-selected={props.value === o.value || undefined}>
            <input type="radio" name={props.name} value={o.value} checked={props.value === o.value} onChange={() => props.onChange(o.value)} />
            <span>
              <strong style={{ fontWeight: 600 }}>{o.label}</strong>
              {o.description && <span className="ui-muted" style={{ display: 'block', fontSize: 12.5, marginTop: 2 }}>{o.description}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
