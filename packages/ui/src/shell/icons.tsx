import type { ReactElement, SVGProps } from 'react'
import type { NavItemId } from './nav'

/**
 * The line icons from the design canvas, path for path. They are drawn rather
 * than imported from an icon set so the shipped product matches the design
 * exactly and carries no icon dependency.
 *
 * Every icon is decorative: the label beside it, or the accessible name on the
 * control wrapping it, is what a screen reader announces.
 */

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number }

function Icon({ size = 19, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function BrandMark(props: IconProps) {
  return (
    <Icon size={20} strokeLinecap="butt" {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  )
}

export function DashboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />
    </Icon>
  )
}

export function OpportunitiesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 3L5 14h5.5l-1 7L19 10h-6z" />
    </Icon>
  )
}

export function ContentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </Icon>
  )
}

export function ProductsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </Icon>
  )
}

export function PerformanceIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20V9M10 20V4M16 20v-7M22 20H2" />
    </Icon>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </Icon>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <Icon size={13} strokeWidth={2} {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  )
}

export function BellIcon(props: IconProps) {
  return (
    <Icon size={18} {...props}>
      <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M10.5 20a2 2 0 0 0 3 0" />
    </Icon>
  )
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon size={15} strokeWidth={2} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v.01M11 12h1v4h1" />
    </Icon>
  )
}

export function AccountIcon(props: IconProps) {
  return (
    <Icon size={18} {...props}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon size={15} strokeWidth={2} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  )
}

export const NAV_ICONS: Readonly<Record<NavItemId, (props: IconProps) => ReactElement>> = {
  dashboard: DashboardIcon,
  opportunities: OpportunitiesIcon,
  content: ContentIcon,
  products: ProductsIcon,
  performance: PerformanceIcon,
  settings: SettingsIcon,
}

export function MoreIcon(props: IconProps) {
  return (
    <Icon strokeWidth={2.4} {...props}>
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </Icon>
  )
}
