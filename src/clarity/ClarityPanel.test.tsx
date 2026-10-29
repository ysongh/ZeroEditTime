import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { describe, expect, it, vi } from 'vitest'
import ClarityPanel, { type ClarityPanelProps } from './ClarityPanel'
import type { ClarityReviewSuggestion } from './review'

const SUGGESTIONS: ClarityReviewSuggestion[] = [
  {
    sentenceId: 'sentence:2:5',
    text: '  The same setup works here.  ',
    sourceRange: { start: 41.234567, end: 49.875432 },
    reason: 'repeated-explanation',
    explanation: 'The preceding sentence already explains the setup.',
    selected: true,
  },
  {
    sentenceId: 'sentence:8:11',
    text: 'Here is an unrelated story.',
    sourceRange: { start: 70, end: 75 },
    reason: 'off-topic-detail',
    explanation: 'This story does not explain the demo.',
    selected: false,
  },
]

type HostProps = {
  children?: ReactNode
  id?: string
  htmlFor?: string
  type?: string
  role?: string
  title?: string
  value?: string
  disabled?: boolean
  checked?: boolean
  maxLength?: number
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-live'?: string
  'aria-atomic'?: string
  onClick?: () => void
  onChange?: (event: { target: { value: string; checked: boolean } }) => void
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return Children.toArray(node).map(textOf).join('')
  return textOf((node as ReactElement<HostProps>).props.children)
}

function findHosts(node: ReactNode, type: string): ReactElement<HostProps>[] {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<HostProps>
  const nested = Children.toArray(element.props.children).flatMap((child) => findHosts(child, type))
  return element.type === type ? [element, ...nested] : nested
}

function findButton(view: ReactNode, label: string): ReactElement<HostProps> {
  const button = findHosts(view, 'button').find((node) => textOf(node) === label)
  if (button === undefined) throw new Error(`Missing button: ${label}`)
  return button
}

function statusText(view: ReactNode): string {
  return textOf(findHosts(view, 'div').find((node) => node.props.role === 'status'))
}

function renderPanel(patch: Partial<ClarityPanelProps> = {}): ReactElement {
  return ClarityPanel({
    draft: { targetDuration: '60', audience: 'Developers', mustStay: 'Setup and final result.' },
    onDraftChange: vi.fn(),
    availability: 'ready',
    status: 'complete',
    suggestions: SUGGESTIONS,
    currentDurationSeconds: 90,
    proposedDurationSeconds: 81.359135,
    targetDurationSeconds: 60,
    onAnalyze: vi.fn(),
    onSelect: vi.fn(),
    onPlaySentence: vi.fn(),
    onDiscard: vi.fn(),
    ...patch,
  })
}

describe('ClarityPanel', () => {
  it('renders labeled optional settings without truncating draft input', () => {
    const view = renderPanel()
    const fields = [...findHosts(view, 'input'), ...findHosts(view, 'textarea')]
      .filter((node) => node.props.type !== 'checkbox')
    const labels = findHosts(view, 'label')

    expect(fields.map((node) => node.props.value)).toEqual([
      '60', 'Developers', 'Setup and final result.',
    ])
    for (const field of fields) {
      const label = labels.find((node) => node.props.htmlFor === field.props.id)
      expect(label).toBeDefined()
      expect(textOf(label)).toContain('Optional')
      expect(field.props.maxLength).toBeUndefined()
      expect(field.props.disabled).not.toBe(true)
    }
    expect(textOf(view)).toContain('Target duration (seconds)')
    expect(textOf(view)).toContain('Audience')
    expect(textOf(view)).toContain('What must stay?')
  })

  it.each([
    ['clarity-target-duration', 'targetDuration', '45.5'],
    ['clarity-audience', 'audience', 'New users'],
    ['clarity-must-stay', 'mustStay', 'Keep every caveat.'],
  ] as const)('forwards changes to %s without mutating the draft', (id, key, value) => {
    const draft = { targetDuration: '60', audience: 'Developers', mustStay: 'Keep setup.' }
    const before = { ...draft }
    const onDraftChange = vi.fn()
    const view = renderPanel({ draft, onDraftChange, status: 'analyzing' })
    const field = [...findHosts(view, 'input'), ...findHosts(view, 'textarea')]
      .find((node) => node.props.id === id)

    field?.props.onChange?.({ target: { value, checked: false } })

    expect(onDraftChange).toHaveBeenCalledExactlyOnceWith({ ...draft, [key]: value })
    expect(draft).toEqual(before)
    expect(field?.props.disabled).not.toBe(true)
  })

  it('starts analysis only through the explicit button callback', () => {
    const onAnalyze = vi.fn()
    const onSelect = vi.fn()
    const onPlaySentence = vi.fn()
    const onDiscard = vi.fn()
    const view = renderPanel({ onAnalyze, onSelect, onPlaySentence, onDiscard })

    expect(onAnalyze).not.toHaveBeenCalled()
    findButton(view, 'Suggest clarity edits').props.onClick?.()

    expect(onAnalyze).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onPlaySentence).not.toHaveBeenCalled()
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'invalid', 'oversized'] as const)(
    'disables analysis and displays the supplied %s feedback',
    (availability) => {
      const message = `${availability}: helpful validation detail.`
      const view = renderPanel({ availability, message })

      expect(findButton(view, 'Suggest clarity edits').props.disabled).toBe(true)
      expect(statusText(view)).toContain(message)
      expect(findHosts(view, 'article')).toEqual([])
      expect(textOf(view)).not.toContain('Proposed duration')
    },
  )

  it('provides a helpful prerequisite message and omits unavailable durations', () => {
    const view = renderPanel({
      availability: 'unavailable', status: 'idle', suggestions: [], currentDurationSeconds: 0,
    })

    expect(statusText(view)).toContain('Load a video and transcribe it')
    expect(findHosts(view, 'dl')).toEqual([])
    expect(findHosts(view, 'button').map(textOf)).toEqual(['Suggest clarity edits'])
  })

  it('announces loading, disables repeat analysis, and permits Discard while fields remain editable', () => {
    const onDiscard = vi.fn()
    const view = renderPanel({ status: 'analyzing', onDiscard })

    expect(findButton(view, 'Analyzing…').props.disabled).toBe(true)
    expect(statusText(view)).toContain('Analyzing the kept speech for clarity edits…')
    expect(findHosts(view, 'article')).toEqual([])
    expect(findHosts(view, 'input').every((node) => node.props.disabled !== true)).toBe(true)
    findButton(view, 'Discard').props.onClick?.()
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('renders exact local sentence text, human reasons, and precise source-time descriptions', () => {
    const view = renderPanel()
    const cards = findHosts(view, 'article')

    expect(cards).toHaveLength(2)
    expect(findHosts(cards[0], 'h3').map(textOf)).toEqual(['Repeated explanation'])
    expect(findHosts(cards[1], 'h3').map(textOf)).toEqual(['Off-topic detail'])
    expect(findHosts(cards[0], 'p').map(textOf)).toContain(SUGGESTIONS[0].text)
    expect(textOf(cards[0])).toContain(SUGGESTIONS[0].explanation)
    expect(textOf(cards[0])).toContain('0:41.23 – 0:49.88')
    expect(findHosts(cards[0], 'span').find((node) => node.props.title)?.props.title).toBe(
      'Original source time: 41.234567s–49.875432s',
    )
    expect(textOf(cards[0])).toContain(
      'Original source time: from 41.234567 to 49.875432 seconds.',
    )
    for (const card of cards) {
      const descriptionIds = card.props['aria-describedby']?.split(' ')
      expect(descriptionIds).toHaveLength(2)
      for (const id of descriptionIds ?? []) {
        expect([...findHosts(card, 'p'), ...findHosts(card, 'span')].some(
          (node) => node.props.id === id,
        )).toBe(true)
      }
    }
  })

  it.each([
    ['redundant-example', 'Redundant example'],
    ['excessive-introduction', 'Excessive introduction'],
  ] as const)('uses a readable label for %s', (reason, expected) => {
    const view = renderPanel({ suggestions: [{ ...SUGGESTIONS[0], reason }] })
    expect(findHosts(view, 'h3').map(textOf)).toEqual([expected])
  })

  it('uses controlled checkboxes to forward only sentence IDs and selection intent', () => {
    const onSelect = vi.fn()
    const onAnalyze = vi.fn()
    const onPlaySentence = vi.fn()
    const before = structuredClone(SUGGESTIONS)
    const view = renderPanel({ onSelect, onAnalyze, onPlaySentence })
    const checkboxes = findHosts(view, 'input').filter((node) => node.props.type === 'checkbox')

    expect(checkboxes.map((node) => node.props.checked)).toEqual([true, false])
    checkboxes[0].props.onChange?.({ target: { checked: false, value: '' } })
    checkboxes[1].props.onChange?.({ target: { checked: true, value: '' } })

    expect(onSelect.mock.calls).toEqual([
      [SUGGESTIONS[0].sentenceId, false], [SUGGESTIONS[1].sentenceId, true],
    ])
    expect(SUGGESTIONS).toEqual(before)
    expect(onAnalyze).not.toHaveBeenCalled()
    expect(onPlaySentence).not.toHaveBeenCalled()
    for (const checkbox of checkboxes) {
      expect(findHosts(view, 'label').some((node) => node.props.htmlFor === checkbox.props.id)).toBe(true)
      expect(checkbox.props['aria-describedby']).toContain('-text')
    }
  })

  it('auditions the original sentence by ID without forwarding model text or timestamps', () => {
    const onPlaySentence = vi.fn()
    const onSelect = vi.fn()
    const onAnalyze = vi.fn()
    const view = renderPanel({ onPlaySentence, onSelect, onAnalyze })
    const cards = findHosts(view, 'article')
    const play = findButton(cards[0], 'Play original')

    expect(play.props['aria-label']).toBe(
      'Play original sentence. Original source time: from 41.234567 to 49.875432 seconds.',
    )
    play.props.onClick?.()
    expect(onPlaySentence).toHaveBeenCalledExactlyOnceWith(SUGGESTIONS[0].sentenceId)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onAnalyze).not.toHaveBeenCalled()
  })

  it('shows supplied local durations and an unmet target without promising the target', () => {
    const view = renderPanel()

    expect(findHosts(view, 'dt').map(textOf)).toEqual([
      'Current duration', 'Proposed duration', 'Target duration',
    ])
    expect(findHosts(view, 'dd').map(textOf)).toEqual(['90.00s', '81.36s', '60.00s'])
    expect(textOf(view)).toContain('Target not reached.')
    expect(statusText(view)).toContain('2 suggested removals · 1 selected')
  })

  it.each([60, 59.25])('does not claim an unmet target when the proposed duration is %s', (proposedDurationSeconds) => {
    const view = renderPanel({ proposedDurationSeconds })
    expect(textOf(view)).not.toContain('Target not reached.')
  })

  it('keeps target and proposed duration optional', () => {
    const view = renderPanel({ targetDurationSeconds: undefined, proposedDurationSeconds: null })
    expect(findHosts(view, 'dt').map(textOf)).toEqual(['Current duration'])
    expect(textOf(view)).not.toContain('Target not reached.')
  })

  it('shows successful empty analysis only for a completed empty proposal', () => {
    const view = renderPanel({ suggestions: [], proposedDurationSeconds: 90 })
    expect(statusText(view)).toContain('No clarity edits suggested')
    expect(findHosts(view, 'article')).toEqual([])
    expect(findButton(view, 'Suggest clarity edits').props.disabled).toBe(false)
    expect(findButton(view, 'Discard')).toBeDefined()

    for (const status of ['idle', 'analyzing', 'error'] as const) {
      expect(statusText(renderPanel({ status, suggestions: [] }))).not.toContain(
        'No clarity edits suggested',
      )
    }
  })

  it('distinguishes all suggestions deselected from successful empty analysis', () => {
    const view = renderPanel({
      suggestions: SUGGESTIONS.map((suggestion) => ({ ...suggestion, selected: false })),
      proposedDurationSeconds: 90,
    })

    expect(statusText(view)).toContain('2 suggested removals · 0 selected')
    expect(statusText(view)).not.toContain('No clarity edits suggested')
    expect(findHosts(view, 'article')).toHaveLength(2)
  })

  it('exposes a retryable error and an independent Discard action', () => {
    const onDiscard = vi.fn()
    const onSelect = vi.fn()
    const view = renderPanel({ status: 'error', error: 'Model request failed.', onDiscard, onSelect })
    const alert = findHosts(view, 'div').find((node) => node.props.role === 'alert')

    expect(textOf(alert)).toContain('Couldn’t suggest clarity edits.Model request failed.')
    expect(findButton(view, 'Suggest clarity edits').props.disabled).toBe(false)
    expect(findHosts(view, 'article')).toEqual([])
    findButton(view, 'Discard').props.onClick?.()
    expect(onDiscard).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps one stable polite live region across analysis states', () => {
    for (const status of ['idle', 'analyzing', 'complete', 'error'] as const) {
      const view = renderPanel({ status })
      const regions = findHosts(view, 'div').filter((node) => node.props.role === 'status')
      expect(regions).toHaveLength(1)
      expect(regions[0].props).toMatchObject({
        id: 'clarity-panel-status', 'aria-live': 'polite', 'aria-atomic': 'true',
      })
    }
  })
})
