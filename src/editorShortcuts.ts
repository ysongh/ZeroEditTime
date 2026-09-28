// Pure key → editor-command mapping for the global keyboard shortcuts. App owns
// the window listener and runs the command; this module only decides whether
// a keydown is a shortcut at all, so it stays testable without a DOM.

export type EditorShortcut =
  | 'toggle-play'
  | 'set-in'
  | 'set-out'
  | 'split'
  | 'delete-range'
  | 'clear-marks'
  | 'undo'
  | 'seek-back'
  | 'seek-forward'

export type ShortcutKeyEvent = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  defaultPrevented: boolean
  target: EventTarget | null
}

type TargetLike = {
  tagName?: unknown
  isContentEditable?: unknown
  closest?: unknown
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

// Space activates these natively; stealing it would break keyboard users.
const SPACE_ACTIVATED =
  'button, a[href], summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"]'

// Arrow keys already move within these widgets.
const ARROW_OWNERS = '[role="tablist"], [role="radiogroup"], [role="slider"], [role="listbox"], [role="menu"]'

function asTarget(target: EventTarget | null): TargetLike | null {
  return typeof target === 'object' && target !== null
    ? (target as TargetLike)
    : null
}

function isTextEntry(target: TargetLike | null): boolean {
  if (target === null) return false
  return (
    (typeof target.tagName === 'string' &&
      TEXT_ENTRY_TAGS.has(target.tagName.toUpperCase())) ||
    target.isContentEditable === true
  )
}

function isInside(target: TargetLike | null, selector: string): boolean {
  if (target === null || typeof target.closest !== 'function') return false
  return (target.closest as (selector: string) => unknown).call(target, selector) != null
}

/**
 * The editor command for a keydown, or null when the key should be left alone:
 * already handled (defaultPrevented), typed into a field, or owned natively by
 * the focused control.
 */
export function editorShortcutFor(event: ShortcutKeyEvent): EditorShortcut | null {
  if (event.defaultPrevented) return null
  const target = asTarget(event.target)
  if (isTextEntry(target)) return null

  const key = event.key
  if (event.metaKey || event.ctrlKey) {
    const isUndo =
      !event.altKey && !event.shiftKey && key.toLowerCase() === 'z'
    return isUndo ? 'undo' : null
  }
  if (event.altKey) return null

  switch (key) {
    case 'ArrowLeft':
      return isInside(target, ARROW_OWNERS) ? null : 'seek-back'
    case 'ArrowRight':
      return isInside(target, ARROW_OWNERS) ? null : 'seek-forward'
  }

  // Everything below is a one-shot command; ignore auto-repeat.
  if (event.repeat) return null

  switch (key) {
    case ' ':
      return isInside(target, SPACE_ACTIVATED) ? null : 'toggle-play'
    case 'i':
    case 'I':
      return 'set-in'
    case 'o':
    case 'O':
      return 'set-out'
    case 's':
    case 'S':
      return 'split'
    case 'Delete':
    case 'Backspace':
      return 'delete-range'
    case 'Escape':
      return 'clear-marks'
    default:
      return null
  }
}
