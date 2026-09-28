import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EDL } from '../edl/types'
import CaptionExportControls from './CaptionExportControls'

const CAPTIONED_EDL: EDL = {
  version: 1,
  source: { id: 'source', url: 'blob:source', duration: 4 },
  segments: [{ id: 'seg_0_4', start: 0, end: 4 }],
  captions: [
    { id: 'cap_0_25_1_25', text: 'Keep this caption', start: 0.25, end: 1.25 },
  ],
}

type HostProps = {
  checked?: boolean
  children?: ReactNode
  disabled?: boolean
  onChange?: (event: { target: { checked: boolean } }) => void
  onClick?: () => void
  type?: string
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return Children.toArray(node).map(textOf).join('')
  return textOf((node as ReactElement<HostProps>).props.children)
}

function findHosts(node: ReactNode, type: string): ReactElement<HostProps>[] {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<HostProps>
  const nested = Children.toArray(element.props.children).flatMap((child) =>
    findHosts(child, type),
  )
  return element.type === type ? [element, ...nested] : nested
}

function render(
  edl: EDL,
  burnCaptions = true,
  onBurnCaptionsChange = vi.fn(),
): ReactElement | null {
  return CaptionExportControls({ edl, burnCaptions, onBurnCaptionsChange })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CaptionExportControls', () => {
  it('renders nothing when no captions are stored', () => {
    expect(render({ ...CAPTIONED_EDL, captions: [] })).toBeNull()
  })

  it('reflects and reports the burn opt-out', () => {
    const onBurnCaptionsChange = vi.fn()
    const view = render(CAPTIONED_EDL, true, onBurnCaptionsChange)
    const toggle = findHosts(view, 'input').find(
      (input) => input.props.type === 'checkbox',
    )

    expect(toggle?.props.checked).toBe(true)
    toggle?.props.onChange?.({ target: { checked: false } })
    expect(onBurnCaptionsChange).toHaveBeenCalledWith(false)

    const off = findHosts(render(CAPTIONED_EDL, false), 'input')[0]
    expect(off.props.checked).toBe(false)
  })

  it('downloads the prepared output-time SRT', async () => {
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    })
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:srt-download')
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {})
    const view = render(CAPTIONED_EDL)

    const button = findHosts(view, 'button').find(
      (element) => textOf(element) === 'Download SRT',
    )
    button?.props.onClick?.()

    const blob = createObjectUrl.mock.calls[0][0]
    if (!(blob instanceof Blob)) {
      throw new Error('Expected SRT download to use a Blob.')
    }
    expect(await blob.text()).toBe(
      '1\n00:00:00,250 --> 00:00:01,250\nKeep this caption\n\n',
    )
    expect(blob.type).toBe('text/plain')
    expect(anchor.href).toBe('blob:srt-download')
    expect(anchor.download).toBe('zero-edit-time.srt')
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.remove).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:srt-download')
  })

  it('disables the SRT download once every caption has been cut', () => {
    const view = render({
      ...CAPTIONED_EDL,
      segments: [{ id: 'seg_2_4', start: 2, end: 4 }],
    })
    const button = findHosts(view, 'button').find(
      (element) => textOf(element) === 'Download SRT',
    )

    expect(button?.props.disabled).toBe(true)
    expect(textOf(view)).toContain(
      "Every caption's speech has been cut — nothing to burn or download.",
    )
  })
})
