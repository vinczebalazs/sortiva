import * as React from 'react'
import { Cta, Layout, Paragraph } from './layout'

/**
 * Every email that is not the monthly summary. A heading, a line or two, one
 * button. Version `notice.v1`, stamped on every `email_sends` row that uses it.
 *
 * All strings arrive already resolved from the catalogue. This file chooses
 * layout and never words.
 */

export interface NoticeEmailProps {
  readonly previewText: string
  readonly heading: string
  readonly paragraphs: readonly string[]
  readonly cta?: { readonly label: string; readonly url: string }
  readonly footerReason: string
  readonly unsubscribe?: { readonly label: string; readonly url: string }
}

export function NoticeEmail(props: NoticeEmailProps) {
  return (
    <Layout
      previewText={props.previewText}
      heading={props.heading}
      footerReason={props.footerReason}
      {...(props.unsubscribe ? { unsubscribe: props.unsubscribe } : {})}
    >
      {props.paragraphs.map((paragraph, index) => (
        <Paragraph key={index}>{paragraph}</Paragraph>
      ))}
      {props.cta ? <Cta href={props.cta.url}>{props.cta.label}</Cta> : null}
    </Layout>
  )
}
