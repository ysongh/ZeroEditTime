import { describe, expect, it } from 'vitest'
import { editorShortcutFor, type ShortcutKeyEvent } from './editorShortcuts'

function key(
  keyName: string,
  patch: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
  return {
    key: keyName,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    ...patch,
  }
}

function element(tagName: string, matches: string[] = []): EventTarget {
  return {
    tagName,
    isContentEditable: false,
    closest: (selector: string) =>
      matches.some((match) => selector.includes(match)) ? {} : null,
  } as unknown as EventTarget
}

describe('editorShortcutFor', () => {
  it('maps the editor keys to commands', () => {
    expect(editorShortcutFor(key(' '))).toBe('toggle-play')
    expect(editorShortcutFor(key('i'))).toBe('set-in')
    expect(editorShortcutFor(key('O'))).toBe('set-out')
    expect(editorShortcutFor(key('s'))).toBe('split')
    expect(editorShortcutFor(key('Delete'))).toBe('delete-range')
    expect(editorShortcutFor(key('Backspace'))).toBe('delete-range')
    expect(editorShortcutFor(key('Escape'))).toBe('clear-marks')
    expect(editorShortcutFor(key('ArrowLeft'))).toBe('seek-back')
    expect(editorShortcutFor(key('ArrowRight'))).toBe('seek-forward')
    expect(editorShortcutFor(key('z', { metaKey: true }))).toBe('undo')
    expect(editorShortcutFor(key('Z', { ctrlKey: true }))).toBe('undo')
  })

  it('leaves typing, modified keys, and already-handled events alone', () => {
    expect(editorShortcutFor(key('i', { target: element('INPUT') }))).toBeNull()
    expect(editorShortcutFor(key('z', { metaKey: true, target: element('textarea') }))).toBeNull()
    expect(
      editorShortcutFor(key('s', {
        target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget,
      })),
    ).toBeNull()
    expect(editorShortcutFor(key('z', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(editorShortcutFor(key('s', { metaKey: true }))).toBeNull()
    expect(editorShortcutFor(key('i', { altKey: true }))).toBeNull()
    expect(editorShortcutFor(key('Delete', { defaultPrevented: true }))).toBeNull()
  })

  it('keeps native Space activation and widget arrow keys', () => {
    expect(editorShortcutFor(key(' ', { target: element('BUTTON', ['button']) }))).toBeNull()
    expect(editorShortcutFor(key(' ', { target: element('DIV') }))).toBe('toggle-play')
    expect(
      editorShortcutFor(key('ArrowRight', { target: element('BUTTON', ['tablist']) })),
    ).toBeNull()
    expect(
      editorShortcutFor(key('ArrowRight', { target: element('BUTTON', ['button']) })),
    ).toBe('seek-forward')
  })

  it('repeats seeks but not one-shot commands while a key is held', () => {
    expect(editorShortcutFor(key('ArrowLeft', { repeat: true }))).toBe('seek-back')
    expect(editorShortcutFor(key(' ', { repeat: true }))).toBeNull()
    expect(editorShortcutFor(key('s', { repeat: true }))).toBeNull()
  })
})
