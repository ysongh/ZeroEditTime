import {
  Children,
  isValidElement,
  type CSSProperties,
  type MouseEvent,
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
  'aria-atomic'?: string
  'aria-describedby'?: string
  'aria-hidden'?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-live'?: string
  children?: ReactNode
  disabled?: boolean
  id?: string
  onClick?: (event: Pick<MouseEvent<HTMLButtonElement>, 'currentTarget'>) => void
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

function clickButton(
  button: ReactElement<HostProps>,
  currentTarget = {
    ownerDocument: { activeElement: null },
  } as HTMLButtonElement,
): void {
  button.props.onClick?.({ currentTarget })
}

function accessibleTextOf(node: ReactNode): string {
  if (!isValidElement(node)) {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    return Children.toArray(node).map(accessibleTextOf).join('')
  }
  const element = node as ReactElement<HostProps>
  return element.props['aria-hidden'] === 'true'
    ? ''
    : accessibleTextOf(element.props.children)
}

function renderPanel(
  patch: Partial<RetakesPanelProps> = {},
): ReactElement {
  return RetakesPanel({
    recommendations: [RECOMMENDATION, SECOND_RECOMMENDATION],
    analysisStatus: 'complete',
    hasSuccessfulEmptyAnalysis: false,
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

    clickButton(findButton(view, 'Check for retakes'))
    clickButton(findButton(view, 'Play'))
    clickButton(findButton(view, 'Dismiss'))
    const resolveButtons = findHosts(view, 'button').filter(
      (button) => textOf(button.props.children) === 'Mark as re-recorded',
    )
    resolveButtons.forEach((button) => clickButton(button))
    clickButton(findButton(view, 'Copy script'))

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

  it('distinguishes repeated card titles by readable source ranges in every action name', () => {
    const view = renderPanel({
      recommendations: [
        RECOMMENDATION,
        {
          ...SECOND_RECOMMENDATION,
          title: RECOMMENDATION.title,
          suggestedScript: 'Another clean sentence.',
        },
      ],
    })
    const articles = findHosts(view, 'article')
    const sourceRanges = [
      'Original source time: from 41.25 seconds to 49.9 seconds',
      'Original source time: from 1 minute 18.25 seconds to 1 minute 25.9 seconds',
    ]

    for (const [index, article] of articles.entries()) {
      const heading = findHosts(article, 'h3')[0]
      expect(article.props['aria-labelledby']).toBe(heading.props.id)
      expect(textOf(heading)).toBe(RECOMMENDATION.title)
      for (const button of findHosts(article, 'button')) {
        expect(button.props['aria-label']).toContain(textOf(button))
        expect(button.props['aria-label']).toContain(RECOMMENDATION.title)
        expect(button.props['aria-label']).toContain(sourceRanges[index])
      }
      const accessibleText = accessibleTextOf(article)
      expect(accessibleText).toContain(sourceRanges[index])
      expect(accessibleText).not.toMatch(/\d{2}:\d{2}/)
      expect(accessibleText.match(/Original source time/g)).toHaveLength(1)
    }
    const names = articles.flatMap((article) =>
      findHosts(article, 'button').map((button) => button.props['aria-label']),
    )
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(articles.map((article) => article.props['aria-labelledby'])).size).toBe(2)
  })

  it('keeps copy announcements associated with their card across feedback changes and reordering', () => {
    const recommendations = [
      RECOMMENDATION,
      { ...SECOND_RECOMMENDATION, suggestedScript: 'Use one clean sentence.' },
    ]
    const expectedFeedback = [
      [null, '', ''],
      ['copying', 'Copying…', ''],
      ['copied', 'Copied.', ''],
      ['error', '', 'Couldn’t copy script. Try again.'],
    ] as const
    let initialDescription: string | undefined

    for (const [status, successText, errorText] of expectedFeedback) {
      const view = renderPanel({
        recommendations: status === 'error' ? [...recommendations].reverse() : recommendations,
        copyFeedback: status === null ? null : {
          recommendationId: RECOMMENDATION.id,
          status,
        },
      })
      const articles = findHosts(view, 'article')
      const card = articles.find((article) =>
        textOf(findHosts(article, 'h3')[0]) === RECOMMENDATION.title,
      )!
      const otherCard = articles.find((article) => article !== card)!
      const description = findButton(card, 'Copy script').props['aria-describedby']
      initialDescription ??= description
      expect(description).toBe(initialDescription)
      const ids = description!.split(' ')
      const feedback = ids.map((id) =>
        findHosts(card, 'span').find((span) => span.props.id === id),
      )
      expect(feedback[0]?.props).toMatchObject({
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      })
      expect(feedback[1]?.props).toMatchObject({ role: 'alert', 'aria-atomic': 'true' })
      expect(feedback.map(textOf)).toEqual([successText, errorText])
      expect(findButton(otherCard, 'Copy script').props['aria-describedby']).not.toBe(description)
      expect(
        findHosts(otherCard, 'span').filter((span) => span.props.role !== undefined).map(textOf),
      ).toEqual(['', ''])
    }
  })

  it.each([
    { target: 'next', next: true, previous: true, analyze: true },
    { target: 'previous', next: false, previous: true, analyze: true },
    { target: 'analyze', next: false, previous: false, analyze: true },
    { target: 'heading', next: false, previous: false, analyze: false },
  ] as const)('moves focus to $target when the focused card is removed', (scenario) => {
    for (const action of ['Dismiss', 'Mark as re-recorded']) {
      const targets = {
        next: { focus: vi.fn() },
        previous: { focus: vi.fn() },
        analyze: { focus: vi.fn() },
        heading: { focus: vi.fn() },
      }
      const item = {
        nextElementSibling: scenario.next ? { querySelector: () => targets.next } : null,
        previousElementSibling: scenario.previous ? { querySelector: () => targets.previous } : null,
      }
      const panel = {
        querySelector: (selector: string) => selector === 'h2'
          ? targets.heading
          : scenario.analyze ? targets.analyze : null,
      }
      const ownerDocument: { activeElement: unknown } = { activeElement: null }
      const currentTarget = {
        ownerDocument,
        closest: (selector: string) => selector === 'li' ? item : panel,
      } as unknown as HTMLButtonElement
      ownerDocument.activeElement = currentTarget
      const onRemove = vi.fn(() => {
        // Focus must leave the card before its owner removes it.
        expect(targets[scenario.target].focus).toHaveBeenCalledOnce()
      })
      const view = renderPanel({ onDismiss: onRemove, onResolve: onRemove })

      clickButton(findButton(view, action), currentTarget)

      expect(onRemove).toHaveBeenCalledWith(RECOMMENDATION.id)
      for (const [name, target] of Object.entries(targets)) {
        expect(target.focus).toHaveBeenCalledTimes(name === scenario.target ? 1 : 0)
      }
    }
  })

  it('does not move unrelated focus when an unfocused action removes a card', () => {
    const closest = vi.fn()
    const currentTarget = {
      ownerDocument: { activeElement: { focus: vi.fn() } },
      closest,
    } as unknown as HTMLButtonElement
    const onDismiss = vi.fn()
    const onResolve = vi.fn()
    const view = renderPanel({ onDismiss, onResolve })

    clickButton(findButton(view, 'Dismiss'), currentTarget)
    clickButton(findButton(view, 'Mark as re-recorded'), currentTarget)

    expect(onDismiss).toHaveBeenCalledWith(RECOMMENDATION.id)
    expect(onResolve).toHaveBeenCalledWith(RECOMMENDATION.id)
    expect(closest).not.toHaveBeenCalled()
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
      analysisProgress: { completed: 2, failed: 1, total: 5 },
    })

    expect(findButton(view, 'Checking…').props).toMatchObject({
      disabled: true,
      type: 'button',
    })
    const status = findHosts(view, 'div').find(
      (element) => element.props.role === 'status',
    )
    expect(textOf(status)).toContain('Checked 3 of 5 sections…')
  })

  it('announces initial, checking, completed, and partial outcomes through the summary live region', () => {
    const cases: [Partial<RetakesPanelProps>, string][] = [
      [{ recommendations: [], analysisStatus: 'idle' }, '0 open recommendations.'],
      [{ analysisStatus: 'analyzing' }, 'Checking for retakes…'],
      [{ recommendations: [RECOMMENDATION] }, '1 section may be worth recording again.'],
      [{ recommendations: [], hasSuccessfulEmptyAnalysis: true }, 'No retakes recommended'],
      [
        { analysisProgress: { completed: 2, failed: 1, total: 3 } },
        'Checked 3 sections. 2 completed; 1 could not be analyzed.',
      ],
    ]

    for (const [patch, expected] of cases) {
      const view = renderPanel(patch)
      const summaries = findHosts(view, 'div').filter(
        (element) => element.props.role === 'status',
      )
      expect(summaries).toHaveLength(1)
      expect(summaries[0].props).toMatchObject({
        'aria-live': 'polite',
        'aria-atomic': 'true',
      })
      expect(textOf(summaries[0])).toContain(expected)
    }
  })

  it('reports partial success while retaining valid recommendations', () => {
    const view = renderPanel({
      recommendations: [RECOMMENDATION],
      analysisStatus: 'complete',
      analysisProgress: { completed: 5, failed: 2, total: 7 },
    })

    expect(textOf(view)).toContain(
      'Checked 7 sections. 5 completed; 2 could not be analyzed.',
    )
    expect(textOf(view)).toContain(RECOMMENDATION.title)
    expect(findHosts(view, 'article')).toHaveLength(1)
    expect(findButton(view, 'Check for retakes').props.disabled).not.toBe(
      true,
    )
  })

  it('shows a retryable controlled error without hiding older advice', () => {
    const view = renderPanel({
      recommendations: [RECOMMENDATION],
      analysisStatus: 'error',
      analysisError: 'Retake request failed.',
    })
    const alert = findHosts(view, 'div').find(
      (element) => element.props.role === 'alert',
    )

    expect(textOf(alert)).toBe(
      'Couldn’t check for retakes.Retake request failed.',
    )
    expect(textOf(view)).toContain(RECOMMENDATION.title)
    expect(findHosts(view, 'article')).toHaveLength(1)
    expect(findButton(view, 'Check for retakes').props.disabled).not.toBe(
      true,
    )
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

  it('treats a proven zero-recommendation result as a successful result', () => {
    const view = renderPanel({
      recommendations: [],
      analysisStatus: 'complete',
      hasSuccessfulEmptyAnalysis: true,
    })
    const text = textOf(view)

    expect(text).toContain('No retakes recommended')
    expect(text).toContain(
      'The sections we checked appear fixable through normal editing.',
    )
    expect(text).not.toContain('0 open recommendations.')
    expect(findHosts(view, 'article')).toEqual([])
    expect(findButton(view, 'Check for retakes').props.disabled).not.toBe(
      true,
    )
  })

  it('does not mistake other zero-visible states for successful analysis', () => {
    for (const analysisStatus of ['idle', 'analyzing', 'error'] as const) {
      const view = renderPanel({
        recommendations: [],
        analysisStatus,
        hasSuccessfulEmptyAnalysis: true,
      })
      expect(textOf(view)).not.toContain('No retakes recommended')
      expect(textOf(view)).toContain('0 open recommendations.')
    }

    const closed = renderPanel({
      recommendations: [
        { ...RECOMMENDATION, status: 'dismissed' },
        { ...SECOND_RECOMMENDATION, status: 'resolved' },
      ],
      hasSuccessfulEmptyAnalysis: true,
    })
    expect(textOf(closed)).not.toContain('No retakes recommended')
    expect(textOf(closed)).toContain('0 open recommendations.')

    const withRecommendation = renderPanel({
      recommendations: [RECOMMENDATION],
      hasSuccessfulEmptyAnalysis: true,
    })
    expect(textOf(withRecommendation)).not.toContain(
      'No retakes recommended',
    )
    expect(textOf(withRecommendation)).toContain(
      '1 section may be worth recording again.',
    )

    const partial = renderPanel({
      recommendations: [],
      analysisStatus: 'complete',
      analysisProgress: { completed: 1, failed: 1, total: 2 },
      hasSuccessfulEmptyAnalysis: true,
    })
    expect(textOf(partial)).not.toContain('No retakes recommended')
    expect(textOf(partial)).toContain(
      'Checked 2 sections. 1 completed; 1 could not be analyzed.',
    )
  })
})
