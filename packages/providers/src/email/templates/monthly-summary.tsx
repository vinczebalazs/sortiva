import * as React from 'react'
import { Cta, Item, Layout, Paragraph, SectionHeading } from './layout'

/**
 * The month in review — what went live, what the quality bar held back and why,
 * what else was done, and what is worth doing next. Version
 * `monthly-summary.v1`.
 *
 * The one rule this template exists to keep is not visible in its markup: no
 * count is ever set against a total. That is enforced on the copy, not here —
 * see the denominator check in `packages/core`.
 */

export interface SummarySection {
  readonly heading: string
  readonly lines: readonly string[]
}

export interface MonthlySummaryEmailProps {
  readonly previewText: string
  readonly brand: string
  readonly heading: string
  readonly paragraphs: readonly string[]
  readonly sections: readonly SummarySection[]
  readonly cta?: { readonly label: string; readonly url: string }
  readonly footerReason: string
  readonly unsubscribe?: { readonly label: string; readonly url: string }
}

export function MonthlySummaryEmail(props: MonthlySummaryEmailProps) {
  return (
    <Layout
      previewText={props.previewText}
      brand={props.brand}
      heading={props.heading}
      footerReason={props.footerReason}
      {...(props.unsubscribe ? { unsubscribe: props.unsubscribe } : {})}
    >
      {props.paragraphs.map((paragraph, index) => (
        <Paragraph key={index}>{paragraph}</Paragraph>
      ))}
      {props.sections.map((section) => (
        <React.Fragment key={section.heading}>
          <SectionHeading>{section.heading}</SectionHeading>
          {section.lines.map((line, index) => (
            <Item key={index}>{line}</Item>
          ))}
        </React.Fragment>
      ))}
      {props.cta ? <Cta href={props.cta.url}>{props.cta.label}</Cta> : null}
    </Layout>
  )
}
