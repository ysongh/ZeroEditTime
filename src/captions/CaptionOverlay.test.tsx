import { isValidElement, type CSSProperties, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Caption } from '../edl/types'
import CaptionOverlay from './CaptionOverlay'

const CAPTIONS: Caption[] = [
  { id: 'first', text: 'First caption', start: 10, end: 12 },
  { id: 'second', text: 'Corrected SDK name', start: 12, end: 14 },
]

function renderAt(currentTime: number): string {
  return renderToStaticMarkup(
    <CaptionOverlay captions={CAPTIONS} currentTime={currentTime} />,
  )
}

describe('CaptionOverlay', () => {
  it('uses half-open source-time intervals at every caption boundary', () => {
    expect(renderAt(9.999)).toBe('')
    expect(renderAt(10)).toContain('First caption')

    const boundary = renderAt(12)
    expect(boundary).not.toContain('First caption')
    expect(boundary).toContain('Corrected SDK name')

    expect(renderAt(14)).toBe('')
  })

  it('previews edited text without intercepting video controls', () => {
    const view = CaptionOverlay({ captions: CAPTIONS, currentTime: 13 })

    expect(isValidElement(view)).toBe(true)
    const overlay = view as ReactElement<{
      children: ReactElement<{ children: string }>
      style: CSSProperties
    }>
    expect(overlay.props.style.pointerEvents).toBe('none')
    expect(overlay.props.children.props.children).toBe('Corrected SDK name')
  })
})
