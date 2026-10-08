import type { UiLanguage } from '../i18n/messages.ts'

const LOCALE: Record<UiLanguage, string> = { en: 'en-GB', hu: 'hu-HU' }

export function formatNumber(n: number, language: UiLanguage): string {
  return new Intl.NumberFormat(LOCALE[language]).format(n)
}

/** A store-local calendar day ("2026-10-09") as a short weekday and date. */
export function formatDay(day: string, language: UiLanguage): string {
  return new Intl.DateTimeFormat(LOCALE[language], { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}

export function formatMoment(iso: string, language: UiLanguage): string {
  return new Intl.DateTimeFormat(LOCALE[language], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}
