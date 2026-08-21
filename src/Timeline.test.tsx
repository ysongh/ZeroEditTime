import {
  Children,
  isValidElement,
  type CSSProperties,
  type MouseEvent,
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
  onClick?: (event: MouseEvent<HTMLDivElement>) => void
  style?: CSSProperties
}

function childDivs(node: ReactNode): Array<ReactElement<DivProps>> {
  if (!isValidElement(node)) {
    return []
  }
  const element = node as ReactElement<DivProps>
  return [
    ...(element.type === 'div' ? [element] : []),
    ...Children.toArray(element.props.children).flatMap(childDivs),
  ]
}

describe('Timeline', () => {
  it('positions kept ranges, reversed selection, and playhead on the full source scale', () => {
    const view = Timeline({
      edl: GAPPED_EDL,
      playhead: 7.5,
      inPoint: 8,
      outPoint: 2,
      onSeek: vi.fn(),
    })
    const divs = childDivs(view)
    const keptBlocks = divs.filter(
      (element) => element.props.style?.borderInline !== undefined,
    )

    expect(
      keptBlocks.map(({ props }) => ({
        left: props.style?.left,
        width: props.style?.width,
      })),
    ).toEqual([
      { left: '0%', width: '30%' },
      { left: '60%', width: '40%' },
    ])

    const selection = divs.find(
      (element) =>
        element.props.style?.background === 'var(--accent-bg)' &&
        element.props.style?.pointerEvents === 'none',
    )
    expect(selection?.props.style).toMatchObject({
      left: '20%',
      width: '60%',
    })

    const playhead = divs.find(
      (element) => element.props.style?.background === 'var(--text-h)',
    )
    expect(playhead?.props.style?.left).toBe('75%')
  })

  it('maps track clicks to source seconds and clamps outside positions', () => {
    const onSeek = vi.fn()
    const view = Timeline({
      edl: GAPPED_EDL,
      playhead: 0,
      inPoint: null,
      outPoint: null,
      onSeek,
    }) as ReactElement<DivProps>
    const currentTarget = {
      getBoundingClientRect: () => ({ left: 100, width: 400 }),
    }

    for (const clientX of [300, 0, 600]) {
      view.props.onClick?.({
        clientX,
        currentTarget,
      } as unknown as MouseEvent<HTMLDivElement>)
    }

    expect(onSeek.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([
      5,
      0,
      10,
    ])
  })

  it('does not seek on a zero-duration source', () => {
    const onSeek = vi.fn()
    const view = Timeline({
      edl: {
        ...GAPPED_EDL,
        source: { ...GAPPED_EDL.source, duration: 0 },
        segments: [],
      },
      playhead: 0,
      inPoint: null,
      outPoint: null,
      onSeek,
    }) as ReactElement<DivProps>

    view.props.onClick?.({
      clientX: 100,
      currentTarget: {
        getBoundingClientRect: () => ({ left: 0, width: 200 }),
      },
    } as unknown as MouseEvent<HTMLDivElement>)

    expect(onSeek).not.toHaveBeenCalled()
  })
})
