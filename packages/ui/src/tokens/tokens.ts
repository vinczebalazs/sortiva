/**
 * The design canvas names its variables in three letters — `--pri`, `--amb`,
 * `--sh`. Those names are what the exported design actually contains, so they
 * are recorded here beside readable ones rather than being quietly renamed: a
 * designer holding the canvas can still find the value a component uses, and
 * nobody re-derives a colour by eye from a screenshot.
 *
 * The CSS custom properties themselves live in `tokens.css`; this module exists
 * so the mapping is checkable and so code that must compute with a token (a
 * chart, a canvas) has one place to read it from.
 */

export interface DesignToken {
  /** The custom property components use, e.g. `--sortiva-accent`. */
  readonly cssVar: string
  /** What the design canvas calls it. */
  readonly canvasVar: string
  readonly value: string
  /** What the token is for, in words, so a new screen picks the right one. */
  readonly use: string
}

export const DESIGN_TOKENS: readonly DesignToken[] = [
  // Surfaces
  { cssVar: '--sortiva-ground', canvasVar: '--ground', value: '#e8e9f0', use: 'The page behind everything; cards float on it.' },
  { cssVar: '--sortiva-surface', canvasVar: '--card', value: '#ffffff', use: 'Card and panel background.' },
  { cssVar: '--sortiva-surface-sunken', canvasVar: '--soft', value: '#f5f6fa', use: 'A quieter area inside a card — an inset row, a why-line, an empty cell.' },

  // Text
  { cssVar: '--sortiva-text', canvasVar: '--ink', value: '#191b23', use: 'Primary text and headings.' },
  { cssVar: '--sortiva-text-secondary', canvasVar: '--ink2', value: '#454a5c', use: 'Body text that sits under a heading.' },
  { cssVar: '--sortiva-text-muted', canvasVar: '--mut', value: '#6f7488', use: 'Supporting text, captions, inactive icons.' },
  { cssVar: '--sortiva-text-faint', canvasVar: '--faint', value: '#878da0', use: 'Labels, and the locked navigation icons.' },

  // Lines
  { cssVar: '--sortiva-line', canvasVar: '--line', value: '#edeef3', use: 'Divider inside a card.' },
  { cssVar: '--sortiva-line-strong', canvasVar: '--line2', value: '#e2e4ec', use: 'The border of an outlined control.' },

  // Accent — the single action colour
  { cssVar: '--sortiva-accent', canvasVar: '--pri', value: '#6470f3', use: 'The one action colour: primary buttons, the selected navigation item, links.' },
  { cssVar: '--sortiva-accent-soft', canvasVar: '--pri-s', value: '#eeeffe', use: 'Accent tint behind an accent-coloured item.' },

  // Status
  { cssVar: '--sortiva-positive', canvasVar: '--grn', value: '#12a150', use: 'Improvement, success, a connected integration.' },
  { cssVar: '--sortiva-positive-soft', canvasVar: '--grn-s', value: '#e7f7ee', use: 'Tint behind a positive state.' },
  { cssVar: '--sortiva-critical', canvasVar: '--red', value: '#e5484d', use: 'Something is stopping the product working — a failed payment, a rejection.' },
  { cssVar: '--sortiva-critical-soft', canvasVar: '--red-s', value: '#fdecee', use: 'Tint behind a critical banner.' },
  { cssVar: '--sortiva-warning', canvasVar: '--amb', value: '#e8890c', use: 'Needs the merchant to act — a lost connection, a held topic.' },
  { cssVar: '--sortiva-warning-soft', canvasVar: '--amb-s', value: '#fdf3e4', use: 'Tint behind a warning banner or ribbon.' },

  // Action-type colours, one per opportunity type
  { cssVar: '--sortiva-optimize', canvasVar: '--cy', value: '#0e9bb8', use: 'The Optimize action type.' },
  { cssVar: '--sortiva-optimize-soft', canvasVar: '--cy-s', value: '#e5f6fa', use: 'Tint for the Optimize action type.' },
  { cssVar: '--sortiva-refresh', canvasVar: '--pur', value: '#8b5cf6', use: 'The Refresh action type.' },
  { cssVar: '--sortiva-refresh-soft', canvasVar: '--pur-s', value: '#f3eefe', use: 'Tint for the Refresh action type.' },

  // Shape
  { cssVar: '--sortiva-radius', canvasVar: '--r', value: '18px', use: 'Card corner.' },
  { cssVar: '--sortiva-radius-inner', canvasVar: '--r2', value: '14px', use: 'A card nested inside a card; a calendar cell.' },
  { cssVar: '--sortiva-shadow', canvasVar: '--sh', value: '0 1px 2px rgba(21,25,42,.04),0 8px 24px -6px rgba(21,25,42,.08)', use: 'The lift every card has.' },
  { cssVar: '--sortiva-shadow-raised', canvasVar: '--shl', value: '0 2px 4px rgba(21,25,42,.04),0 18px 40px -10px rgba(21,25,42,.14)', use: 'A card that outranks the ones around it — the growth headline, a drawer.' },

  // Type
  { cssVar: '--sortiva-font-heading', canvasVar: '--fh', value: '"Poppins", system-ui, sans-serif', use: 'Headings and figures that carry weight.' },
  { cssVar: '--sortiva-font-body', canvasVar: '--fb', value: '"Plus Jakarta Sans", system-ui, sans-serif', use: 'Interface text and numbers.' },
]

export const TOKENS_BY_CANVAS_VAR: Readonly<Record<string, DesignToken>> = Object.fromEntries(
  DESIGN_TOKENS.map((token) => [token.canvasVar, token]),
)

export function tokenValue(canvasVar: string): string {
  const token = TOKENS_BY_CANVAS_VAR[canvasVar]
  if (!token) throw new Error(`No design token for the canvas variable "${canvasVar}".`)
  return token.value
}
