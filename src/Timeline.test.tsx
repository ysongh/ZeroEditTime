import {
  Children,
  isValidElement,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { EDL } from './edl/types'
import Timeline from './Timeline'

const GAPPED_EDL: EDL = {
  version: 1,
  source: { id: 'source', url: 'blob:source', duration: 10 },
  segments: [
    { id: 'first', start: 0, end: 3 },
    { id: 'second', start: 6, end: 10 },
  ],
  captions: [],
}

type DivProps = {
  children?: ReactNode
  className?: string
  onDoubleClick?: (event: MouseEvent<HTMLDivElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void
  onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void
  style?: CSSProperties
}

function allDivs(node: ReactNode): Array<ReactElement<DivProps>> {
  if (!isValidElement(node)) {
    return []
  }
  const element = node as ReactElement<DivProps>
  return [
    ...(element.type === 'div' ? [element] : []),
    ...Children.toArray(element.props.children).flatMap(allDivs),
  ]
}

function byClass(node: ReactNode, className: string): Array<ReactElement<DivProps>> {
  return allDivs(node).filter((element) =>
    element.props.className?.split(' ').includes(className),
  )
}

function positions(elements: Array<ReactElement<DivProps>>) {
  return elements.map(({ props }) => ({
    left: props.style?.left,
    width: props.style?.width,
  }))
}

function track(left = 100, width = 400, captured = false) {
  return {
    getBoundingClientRect: () => ({ left, width }),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => captured),
  }
}

function pointer(clientX: number, currentTarget: ReturnType<typeof track>) {
  return {
    button: 0,
    pointerId: 1,
    clientX,
    currentTarget,
  } as unknown as PointerEvent<HTMLDivElement>
}

function render(patch: Partial<Parameters<typeof Timeline>[0]> = {}) {
  return Timeline({
    edl: GAPPED_EDL,
    playhead: 0,
    inPoint: null,
    outPoint: null,
    onSeek: vi.fn(),
    ...patch,
  }) as ReactElement<DivProps>
}

describe('Timeline', () => {
  it('positions kept ranges, cut gaps, reversed selection, and playhead on the full source scale', () => {
    const view = render({ playhead: 7.5, inPoint: 8, outPoint: 2 })

    expect(positions(byClass(view, 'timeline__segment'))).toEqual([
      { left: '0%', width: '30%' },
      { left: '60%', width: '40%' },
    ])
    expect(positions(byClass(view, 'timeline__cut'))).toEqual([
      { left: '30%', width: '30%' },
    ])
    expect(positions(byClass(view, 'timeline__range'))).toEqual([
      { left: '20%', width: '60%' },
    ])
    expect(byClass(view, 'timeline__mark--in')[0].props.style?.left).toBe('80%')
    expect(byClass(view, 'timeline__mark--out')[0].props.style?.left).toBe('20%')
    expect(byClass(view, 'timeline__playhead')[0].props.style?.left).toBe('75%')
  })

  it('marks splits between adjacent segments and hatches the head and tail', () => {
    const view = render({
      edl: {
        ...GAPPED_EDL,
        segments: [
          { id: 'a', start: 1, end: 4 },
          { id: 'b', start: 4, end: 9 },
        ],
      },
    })

    expect(byClass(view, 'timeline__split').map((el) => el.props.style?.left))
      .toEqual(['40%'])
    expect(positions(byClass(view, 'timeline__cut'))).toEqual([
      { left: '0%', width: '10%' },
      { left: '90%', width: '10%' },
    ])
  })

  it('draws speech activity only when transcript timings are given', () => {
    expect(byClass(render(), 'timeline__speech')).toEqual([])
    const withSpeech = render({ speech: [{ start: 0, end: 1 }] })
    expect(byClass(withSpeech, 'timeline__speech')).toHaveLength(1)
  })

  it('maps pointer presses to source seconds and clamps outside positions', () => {
    const onSeek = vi.fn()
    const view = render({ onSeek })
    const target = track()

    for (const clientX of [300, 0, 600]) {
      view.props.onPointerDown?.(pointer(clientX, target))
    }

    expect(onSeek.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([5, 0, 10])
    expect(target.setPointerCapture).toHaveBeenCalledWith(1)
  })

  it('scrubs on pointer move only while the press holds capture', () => {
    const onSeek = vi.fn()
    const view = render({ onSeek })

    view.props.onPointerMove?.(pointer(200, track()))
    expect(onSeek).not.toHaveBeenCalled()

    view.props.onPointerMove?.(pointer(200, track(100, 400, true)))
    expect(onSeek).toHaveBeenCalledWith(2.5)
  })

  it('does not seek on a zero-duration source', () => {
    const onSeek = vi.fn()
    const view = render({
      edl: {
        ...GAPPED_EDL,
        source: { ...GAPPED_EDL.source, duration: 0 },
        segments: [],
      },
      onSeek,
    })

    view.props.onPointerDown?.(pointer(100, track(0, 200)))

    expect(onSeek).not.toHaveBeenCalled()
  })

  it('selects the kept segment under a double-click and ignores cut gaps', () => {
    const onSelectRange = vi.fn()
    const view = render({ onSelectRange })

    view.props.onDoubleClick?.(
      pointer(380, track()) as unknown as MouseEvent<HTMLDivElement>,
    )
    view.props.onDoubleClick?.(
      pointer(280, track()) as unknown as MouseEvent<HTMLDivElement>,
    )

    expect(onSelectRange.mock.calls).toEqual([[6, 10]])
  })

  it('steps the playhead from the keyboard and clamps to the source', () => {
    const onSeek = vi.fn()
    const view = render({ playhead: 9.5, onSeek })
    const press = (key: string, shiftKey = false) => {
      const preventDefault = vi.fn()
      view.props.onKeyDown?.({
        key,
        shiftKey,
        preventDefault,
      } as unknown as KeyboardEvent<HTMLDivElement>)
      return preventDefault
    }

    press('ArrowRight')
    press('ArrowLeft', true)
    press('Home')
    press('End')
    expect(press('a')).not.toHaveBeenCalled()

    expect(onSeek.mock.calls.map(([t]) => t)).toEqual([10, 4.5, 0, 10])
  })
})
