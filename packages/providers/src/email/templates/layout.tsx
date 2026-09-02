import * as React from 'react'
import { Body, Container, Head, Html, Link, Preview, Section, Text } from '@react-email/components'

/**
 * The shell every Sortiva email sits in.
 *
 * Deliberately plain: a table-free single column, system fonts, no images and
 * no remote assets. Email clients disagree about almost everything, and the one
 * thing that renders identically everywhere is text in a container. There is
 * also nothing here to load, so a merchant reading on a train sees the whole
 * message.
 *
 * It contains no sentences. Everything a merchant reads is passed in already
 * resolved from the string catalogue, so this file can be changed without
 * anyone reviewing copy, and copy can be changed without anyone reading TSX.
 */

const styles = {
  body: { backgroundColor: '#f6f6f4', margin: 0, padding: '24px 0' },
  container: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    margin: '0 auto',
    maxWidth: '560px',
    padding: '32px',
  },
  brand: { color: '#6b6b66', fontSize: '13px', letterSpacing: '0.08em', margin: '0 0 24px' },
  heading: { color: '#141413', fontSize: '22px', lineHeight: '1.3', margin: '0 0 16px' },
  text: { color: '#2c2c2a', fontSize: '15px', lineHeight: '1.6', margin: '0 0 14px' },
  sectionHeading: {
    color: '#141413',
    fontSize: '13px',
    fontWeight: 600,
    letterSpacing: '0.06em',
    margin: '28px 0 10px',
    textTransform: 'uppercase' as const,
  },
  item: { color: '#2c2c2a', fontSize: '15px', lineHeight: '1.6', margin: '0 0 8px' },
  cta: {
    backgroundColor: '#141413',
    borderRadius: '6px',
    color: '#ffffff',
    display: 'inline-block',
    fontSize: '15px',
    margin: '18px 0 4px',
    padding: '11px 20px',
    textDecoration: 'none',
  },
  footer: { color: '#8a8a83', fontSize: '12px', lineHeight: '1.6', margin: '28px 0 0' },
  footerLink: { color: '#8a8a83', fontSize: '12px' },
} as const

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'

export interface LayoutProps {
  readonly previewText: string
  readonly heading: string
  readonly footerReason: string
  readonly unsubscribe?: { readonly label: string; readonly url: string }
  readonly children: React.ReactNode
}

export function Layout(props: LayoutProps) {
  return (
    <Html lang="en">
      <Head />
      {/* What a mail client shows beside the subject, before the message is opened. */}
      <Preview>{props.previewText}</Preview>
      <Body style={{ ...styles.body, fontFamily: FONT_STACK }}>
        <Container style={styles.container}>
          <Text style={styles.brand}>SORTIVA</Text>
          <Text style={styles.heading}>{props.heading}</Text>
          {props.children}
          <Section>
            <Text style={styles.footer}>
              {props.footerReason}
              {props.unsubscribe ? ' ' : null}
              {props.unsubscribe ? (
                <Link href={props.unsubscribe.url} style={styles.footerLink}>
                  {props.unsubscribe.label}
                </Link>
              ) : null}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export function Paragraph(props: { readonly children: React.ReactNode }) {
  return <Text style={styles.text}>{props.children}</Text>
}

export function SectionHeading(props: { readonly children: React.ReactNode }) {
  return <Text style={styles.sectionHeading}>{props.children}</Text>
}

export function Item(props: { readonly children: React.ReactNode }) {
  return <Text style={styles.item}>{props.children}</Text>
}

export function Cta(props: { readonly href: string; readonly children: React.ReactNode }) {
  return (
    <Link href={props.href} style={styles.cta}>
      {props.children}
    </Link>
  )
}
