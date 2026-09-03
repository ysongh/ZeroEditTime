import {
  Children,
  isValidElement,
  type CSSProperties,
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
  style?: CSSProperties
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
    onPlaySourceRange: vi.fn(),
    copyFeedback: null,
    onDismiss: vi.fn(),
    onResolve: vi.fn(),
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
    expect(
      findHosts(view, 'span').find(
        (element) => element.props.title !== undefined,
      )?.props.title,
    ).toBe(
      'Original source time: 41.250s–49.900s',
    )
  })

  it('distinguishes every severity with modest, humane badges', () => {
    const recommended = {
      ...RECOMMENDATION,
      id: 'retake_41250_49900_repeated-attempts',
      severity: 'recommended' as const,
      title: 'Repeated attempt',
    }
    const stronglyRecommended = {
      ...RECOMMENDATION,
      id: 'retake_60000_65000_severe-stumble',
      startSourceMs: 60_000,
      endSourceMs: 65_000,
    }
    const view = renderPanel({
      recommendations: [
        recommended,
        stronglyRecommended,
        SECOND_RECOMMENDATION,
      ],
    })
    const label = (text: string) =>
      findHosts(view, 'span').find(
        (element) => textOf(element.props.children) === text,
      )

    expect(label('Suggestion')?.props.style).toMatchObject({
      background: 'var(--code-bg)',
      borderColor: 'var(--border)',
      fontWeight: 500,
    })
    expect(label('Recommended')?.props.style).toMatchObject({
      background: 'var(--accent-bg)',
      borderColor: 'var(--accent-border)',
      fontWeight: 500,
    })
    expect(label('Strongly recommended')?.props.style).toMatchObject({
      background: 'var(--accent-bg)',
      borderColor: 'var(--accent)',
      fontWeight: 600,
    })
    expect(findHosts(view, 'article').map(textOf)).toEqual([
      expect.stringContaining('Recommended'),
      expect.stringContaining('Strongly recommended'),
      expect.stringContaining('Suggestion'),
    ])
  })

  it('forwards playback, workflow, and exact script-copy actions', () => {
    const onAnalyze = vi.fn()
    const onPlaySourceRange = vi.fn()
    const onDismiss = vi.fn()
    const onResolve = vi.fn()
    const onCopyScript = vi.fn()
    const view = renderPanel({
      onAnalyze,
      onPlaySourceRange,
      onDismiss,
      onResolve,
      onCopyScript,
    })

    findButton(view, 'Check for retakes').props.onClick?.()
    findHosts(view, 'button')
      .filter((button) => textOf(button.props.children) === 'Play')[0]
      .props.onClick?.()
    findHosts(view, 'button')
      .filter((button) => textOf(button.props.children) === 'Dismiss')[0]
      .props.onClick?.()
    const resolveButtons = findHosts(view, 'button').filter(
      (button) => textOf(button.props.children) === 'Mark as re-recorded',
    )
    resolveButtons.forEach((button) => button.props.onClick?.())
    findButton(view, 'Copy script').props.onClick?.()

    expect(onAnalyze).toHaveBeenCalledOnce()
    expect(onPlaySourceRange).toHaveBeenCalledWith(
      RECOMMENDATION.startSourceMs,
      RECOMMENDATION.endSourceMs,
    )
    expect(onDismiss).toHaveBeenCalledWith(RECOMMENDATION.id)
    expect(onResolve.mock.calls.map(([id]) => id)).toEqual([
      RECOMMENDATION.id,
      SECOND_RECOMMENDATION.id,
    ])
    expect(onCopyScript).toHaveBeenCalledWith(
      RECOMMENDATION.id,
      RECOMMENDATION.suggestedScript,
    )
    expect(
      findHosts(view, 'p').filter(
        (element) => textOf(element.props.children) === 'Suggested retake',
      ),
    ).toHaveLength(1)
    expect(textOf(view)).toContain(`“${RECOMMENDATION.suggestedScript}”`)
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
    expect(resolveButtons).toHaveLength(2)
  })

  it('shows controlled copy progress, success, and retryable failure', () => {
    const copying = renderPanel({
      copyFeedback: {
        recommendationId: RECOMMENDATION.id,
        status: 'copying',
      },
    })
    expect(findButton(copying, 'Copy script').props.disabled).toBe(true)
    expect(
      textOf(
        findHosts(copying, 'span').find(
          (element) => element.props.role === 'status',
        ),
      ),
    ).toBe('Copying…')

    const copied = renderPanel({
      copyFeedback: {
        recommendationId: RECOMMENDATION.id,
        status: 'copied',
      },
    })
    expect(findButton(copied, 'Copy script').props.disabled).toBe(false)
    expect(textOf(copied)).toContain('Copied.')

    const failed = renderPanel({
      copyFeedback: {
        recommendationId: RECOMMENDATION.id,
        status: 'error',
      },
    })
    expect(findButton(failed, 'Copy script').props.disabled).toBe(false)
    expect(
      textOf(
        findHosts(failed, 'span').find(
          (element) => element.props.role === 'alert',
        ),
      ),
    ).toBe('Couldn’t copy script. Try again.')

    const unrelated = renderPanel({
      recommendations: [
        RECOMMENDATION,
        {
          ...SECOND_RECOMMENDATION,
          suggestedScript: 'Use one clean sentence.',
        },
      ],
      copyFeedback: {
        recommendationId: SECOND_RECOMMENDATION.id,
        status: 'copied',
      },
    })
    const unrelatedArticles = findHosts(unrelated, 'article')
    expect(textOf(unrelatedArticles[0])).not.toContain('Copied.')
    expect(textOf(unrelatedArticles[1])).toContain('Copied.')
    expect(
      findHosts(unrelated, 'button')
        .filter(
          (button) => textOf(button.props.children) === 'Copy script',
        )
        .every((button) => button.props.disabled !== true),
    ).toBe(true)
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
