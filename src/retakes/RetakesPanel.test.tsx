import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { describe, expect, it, vi } from 'vitest'
import RetakesPanel, { type RetakesPanelProps } from './RetakesPanel'
import type { RetakeRecommendation } from './recommendation'

const RECOMMENDATION: RetakeRecommendation = {
  id: 'retake_41250_49900_severe-stumble',
  startSourceMs: 41_250,
  endSourceMs: 49_900,
  reason: 'severe-stumble',
  severity: 'strongly-recommended',
  title: 'Severe stumble',
  explanation: 'The repeated restart leaves no complete clean take.',
  suggestedScript: 'Explain the workflow in one complete sentence.',
  confidence: 0.92,
  status: 'open',
}

const SECOND_RECOMMENDATION: RetakeRecommendation = {
  ...RECOMMENDATION,
  id: 'retake_78250_85900_audio-quality',
  startSourceMs: 78_250,
  endSourceMs: 85_900,
  reason: 'audio-quality',
  severity: 'suggestion',
  title: 'Audio quality issue',
  explanation: 'Background noise is unusually strong here.',
  suggestedScript: undefined,
}

type HostProps = {
  children?: ReactNode
  disabled?: boolean
  onClick?: () => void
  role?: string
  title?: string
  type?: string
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (!isValidElement(node)) {
    return Children.toArray(node).map(textOf).join('')
  }
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

function findButton(view: ReactNode, label: string): ReactElement<HostProps> {
  const button = findHosts(view, 'button').find(
    (element) => textOf(element.props.children) === label,
  )
  if (button === undefined) {
    throw new Error(`Could not find button "${label}".`)
  }
  return button
}

function renderPanel(
  patch: Partial<RetakesPanelProps> = {},
): ReactElement {
  return RetakesPanel({
    recommendations: [RECOMMENDATION, SECOND_RECOMMENDATION],
    analysisStatus: 'complete',
    onAnalyze: vi.fn(),
    onSeekSourceMs: vi.fn(),
    onDismiss: vi.fn(),
    onCopyScript: vi.fn(),
    ...patch,
  })
}

describe('RetakesPanel', () => {
  it('renders only open recommendations with humane labels and source ranges', () => {
    const dismissed = { ...RECOMMENDATION, id: 'dismissed', status: 'dismissed' as const }
    const resolved = { ...RECOMMENDATION, id: 'resolved', status: 'resolved' as const }
    const view = renderPanel({
      recommendations: [
        dismissed,
        RECOMMENDATION,
        resolved,
        SECOND_RECOMMENDATION,
      ],
    })
    const text = textOf(view)

    expect(text).toContain('2 sections may be worth recording again.')
    expect(text).toContain('Strongly recommended · 00:41 – 00:49')
    expect(text).toContain('Suggestion · 01:18 – 01:25')
    expect(text).toContain(RECOMMENDATION.title)
    expect(text).toContain(RECOMMENDATION.explanation)
    expect(findHosts(view, 'article')).toHaveLength(2)
    expect(findHosts(view, 'span')[1].props.title).toBe(
      'Original source time: 41.250s–49.900s',
    )
  })

  it('forwards analyze, source seek, dismiss, and exact script-copy actions', () => {
    const onAnalyze = vi.fn()
    const onSeekSourceMs = vi.fn()
    const onDismiss = vi.fn()
    const onCopyScript = vi.fn()
    const view = renderPanel({
      onAnalyze,
      onSeekSourceMs,
      onDismiss,
      onCopyScript,
    })

    findButton(view, 'Check for retakes').props.onClick?.()
    findHosts(view, 'button')
      .filter((button) => textOf(button.props.children) === 'Seek')[0]
      .props.onClick?.()
    findHosts(view, 'button')
      .filter((button) => textOf(button.props.children) === 'Dismiss')[0]
      .props.onClick?.()
    findButton(view, 'Copy script').props.onClick?.()

    expect(onAnalyze).toHaveBeenCalledOnce()
    expect(onSeekSourceMs).toHaveBeenCalledWith(
      RECOMMENDATION.startSourceMs,
    )
    expect(onDismiss).toHaveBeenCalledWith(RECOMMENDATION.id)
    expect(onCopyScript).toHaveBeenCalledWith(
      RECOMMENDATION.suggestedScript,
    )
    expect(
      findHosts(view, 'button').every(
        (button) => button.props.type === 'button',
      ),
    ).toBe(true)
    expect(
      findHosts(view, 'button').filter(
        (button) => textOf(button.props.children) === 'Copy script',
      ),
    ).toHaveLength(1)
  })

  it('disables repeat analysis and reports supplied progress while checking', () => {
    const view = renderPanel({
      analysisStatus: 'analyzing',
      analysisProgress: { completed: 2, total: 5 },
    })

    expect(findButton(view, 'Checking…').props).toMatchObject({
      disabled: true,
      type: 'button',
    })
    const status = findHosts(view, 'p').find(
      (element) => element.props.role === 'status',
    )
    expect(textOf(status)).toBe('Checked 2 of 5 sections…')
  })

  it('shows a neutral zero-open count without rendering closed cards', () => {
    const view = renderPanel({
      recommendations: [
        { ...RECOMMENDATION, status: 'dismissed' },
        { ...SECOND_RECOMMENDATION, status: 'resolved' },
      ],
    })

    expect(textOf(view)).toContain('0 open recommendations.')
    expect(findHosts(view, 'article')).toEqual([])
  })
})
