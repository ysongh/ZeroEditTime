import {
  Children,
  isValidElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { describe, expect, it, vi } from 'vitest'
import RetakeTimelineTrack, {
  type RetakeTimelineTrackProps,
} from './RetakeTimelineTrack'
import type { RetakeRecommendation } from './recommendation'

function recommendation(
  id: string,
  startSourceMs: number,
  status: RetakeRecommendation['status'] = 'open',
): RetakeRecommendation {
  return {
    id,
    startSourceMs,
    endSourceMs: Math.min(100_000, startSourceMs + 5_000),
    reason: 'severe-stumble',
    severity: 'recommended',
    title: `Recommendation ${id}`,
    explanation: 'A complete clean take is not available nearby.',
    confidence: 0.9,
    status,
  }
}

type HostProps = {
  'aria-hidden'?: string
  'aria-label'?: string
  'aria-pressed'?: boolean
  className?: string
  children?: ReactNode
  onClick?: () => void
  role?: string
  style?: CSSProperties
  title?: string
  tabIndex?: number
  type?: string
}

function findHosts(node: ReactNode, type: string): ReactElement<HostProps>[] {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<HostProps>
  const nested = Children.toArray(element.props.children).flatMap((child) =>
    findHosts(child, type),
  )
  return element.type === type ? [element, ...nested] : nested
}

function renderTrack(
  patch: Partial<RetakeTimelineTrackProps> = {},
): ReactElement | null {
  return RetakeTimelineTrack({
    recommendations: [
      recommendation('first', 25_000),
      recommendation('second', 75_000),
    ],
    selectedRecommendationId: null,
    sourceDurationMs: 100_000,
    onSelectRecommendation: vi.fn(),
    onSeekSourceMs: vi.fn(),
    ...patch,
  })
}

describe('RetakeTimelineTrack', () => {
  it('positions open markers on the full source scale in input order', () => {
    const view = renderTrack()
    const markers = findHosts(view, 'button')

    expect(markers.map((marker) => marker.props.style?.left)).toEqual([
      '25%',
      '75%',
    ])
    expect(markers.map((marker) => marker.props.title)).toEqual([
      'Recommendation first · 00:25–00:30',
      'Recommendation second · 01:15–01:20',
    ])
  })

  it('omits closed recommendations and returns null when none are open', () => {
    const oneOpen = renderTrack({
      recommendations: [
        recommendation('dismissed', 10_000, 'dismissed'),
        recommendation('open', 20_000),
        recommendation('resolved', 30_000, 'resolved'),
      ],
    })

    expect(findHosts(oneOpen, 'button')).toHaveLength(1)
    expect(findHosts(oneOpen, 'button')[0].props.title).toContain(
      'Recommendation open',
    )
    expect(
      renderTrack({
        recommendations: [
          recommendation('dismissed', 10_000, 'dismissed'),
          recommendation('resolved', 30_000, 'resolved'),
        ],
      }),
    ).toBeNull()
  })

  it('selects before seeking and exposes pressed state without relying on color', () => {
    const calls: string[] = []
    const onSelectRecommendation = vi.fn((id: string) => {
      calls.push(`select:${id}`)
    })
    const onSeekSourceMs = vi.fn((sourceMs: number) => {
      calls.push(`seek:${sourceMs}`)
    })
    const view = renderTrack({
      selectedRecommendationId: 'second',
      onSelectRecommendation,
      onSeekSourceMs,
    })
    const markers = findHosts(view, 'button')

    expect(markers[0].props['aria-pressed']).toBe(false)
    expect(markers[1].props['aria-pressed']).toBe(true)
    expect(findHosts(markers[0], 'span')[0].props.children).toBe('△')
    expect(findHosts(markers[1], 'span')[0].props.children).toBe('▲')
    expect(markers[1].props.style).toMatchObject({
      background: 'var(--accent-bg)',
      border: '1px solid var(--accent)',
    })

    markers[1].props.onClick?.()
    expect(calls).toEqual(['select:second', 'seek:75000'])
    expect(onSelectRecommendation).toHaveBeenCalledWith('second')
    expect(onSeekSourceMs).toHaveBeenCalledWith(75_000)
  })

  it('gives native keyboard controls descriptive seek names with exact spoken source ranges', () => {
    const view = renderTrack({
      recommendations: [
        {
          ...recommendation('precise', 41_250),
          endSourceMs: 49_900,
        },
      ],
    })
    const [marker] = findHosts(view, 'button')

    expect(marker.props.type).toBe('button')
    expect(marker.props.tabIndex).toBeUndefined()
    expect(marker.props.className).toBe('retake-timeline-marker')
    expect(marker.props['aria-label']).toBe(
      'Seek to Recommendation precise. Original source time: from 41.25 seconds to 49.9 seconds.',
    )
    expect(marker.props.title).toBe('Recommendation precise · 00:41–00:49')
    expect(findHosts(marker, 'span')[0].props['aria-hidden']).toBe('true')
  })

  it('keeps endpoint markers inside the rail and rejects invalid duration', () => {
    const view = renderTrack({
      recommendations: [
        recommendation('start', 0),
        recommendation('end', 100_000),
      ],
    })
    const markers = findHosts(view, 'button')

    expect(markers[0].props.style).toMatchObject({
      left: '0%',
      transform: 'translateX(0)',
    })
    expect(markers[1].props.style).toMatchObject({
      left: '100%',
      transform: 'translateX(-100%)',
    })
    expect(renderTrack({ sourceDurationMs: 0 })).toBeNull()
    expect(renderTrack({ sourceDurationMs: Number.NaN })).toBeNull()
  })

  it('keeps the rail inert outside native marker buttons', () => {
    const view = renderTrack()
    const groups = findHosts(view, 'div').filter(
      (element) => element.props.role === 'group',
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].props.onClick).toBeUndefined()
    expect(
      findHosts(view, 'button').every(
        (button) => button.props.type === 'button',
      ),
    ).toBe(true)
  })
})
