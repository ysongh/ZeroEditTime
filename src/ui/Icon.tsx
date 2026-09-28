// Thin rounded line icons (Lucide geometry at the design system's 1.75 stroke).
// Always decorative: the control that holds an icon supplies the accessible name.

import type { ReactNode } from 'react'

export type IconName =
  | 'captions'
  | 'check'
  | 'chevron-left'
  | 'chevron-right'
  | 'film'
  | 'image-plus'
  | 'lines'
  | 'minus'
  | 'pause'
  | 'play'
  | 'plus'
  | 'reset'
  | 'scissors'
  | 'search'
  | 'undo'
  | 'upload'
  | 'x'

const FILLED: ReadonlySet<IconName> = new Set(['pause', 'play'])

const PATHS: Record<IconName, ReactNode> = {
  captions: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  film: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4" />
    </>
  ),
  'image-plus': (
    <>
      <path d="M16 5h6M19 2v6" />
      <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      <circle cx="9" cy="9" r="2" />
    </>
  ),
  lines: <path d="M17 6.1H3M21 12.1H3M15.1 18H3" />,
  minus: <path d="M5 12h14" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
    </>
  ),
  play: (
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
  ),
  plus: <path d="M5 12h14M12 5v14" />,
  reset: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12M20 4 8.12 15.88M14.8 14.8 20 20" />
      <circle cx="6" cy="18" r="3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.34-4.34" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5M12 3v12" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
}

type IconProps = {
  name: IconName
  size?: number
  strokeWidth?: number
}

export default function Icon({ name, size = 16, strokeWidth = 1.75 }: IconProps) {
  const filled = FILLED.has(name)
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
