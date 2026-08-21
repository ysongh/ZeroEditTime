import {
  Children,
  isValidElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Caption } from '../edl/types'
import CaptionList from './CaptionList'

const hooks = vi.hoisted(() => ({
  refCursor: 0,
  refs: [] as Array<{ current: unknown }>,
  stateCursor: 0,
  states: [] as unknown[],
  useRef: vi.fn(),
  useState: vi.fn(),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useRef: hooks.useRef,
    useState: hooks.useState,
  }
})

const CAPTIONS: Caption[] = [
  { id: 'first', text: 'First caption', start: 5, end: 6 },
  { id: 'second', text: 'Original SDK name', start: 6, end: 8 },
  { id: 'later', text: 'Later caption', start: 65.25, end: 66 },
]

type HostProps = {
  children?: ReactNode
  onBlur?: () => void
  onChange?: (event: { target: { value: string } }) => void
  onClick?: () => void
  onKeyDown?: (event: {
    key: string
    currentTarget: { blur: () => void }
  }) => void
  style?: CSSProperties
  title?: string
  value?: string
}

function textOf(node: ReactNode): string {
  return Children.toArray(node).join('')
}

function findHost(
  node: ReactNode,
  type: string,
  predicate: (props: HostProps) => boolean,
): ReactElement<HostProps> {
  if (!isValidElement(node)) {
    throw new Error(`Could not find <${type}>.`)
  }
  const element = node as ReactElement<HostProps>
  if (element.type === type && predicate(element.props)) {
    return element
  }
  for (const child of Children.toArray(element.props.children)) {
    if (!isValidElement(child)) {
      continue
    }
    try {
      return findHost(child, type, predicate)
    } catch {
      // Continue walking sibling branches.
    }
  }
  throw new Error(`Could not find <${type}>.`)
}

function renderList(
  currentTime: number,
  onSeek = vi.fn(),
  onEditText = vi.fn(),
): ReactElement {
  hooks.stateCursor = 0
  hooks.refCursor = 0
  return CaptionList({
    captions: CAPTIONS,
    currentTime,
    onSeek,
    onEditText,
  })
}

function captionText(view: ReactNode, text: string): ReactElement<HostProps> {
  return findHost(
    view,
    'span',
    (props) => props.title === 'Click to edit' && textOf(props.children) === text,
  )
}

beforeEach(() => {
  hooks.refs.length = 0
  hooks.states.length = 0
  hooks.refCursor = 0
  hooks.stateCursor = 0
  hooks.useRef.mockReset()
  hooks.useState.mockReset()
  hooks.useRef.mockImplementation((initial: unknown) => {
    const index = hooks.refCursor
    hooks.refCursor += 1
    if (index >= hooks.refs.length) {
      hooks.refs.push({ current: initial })
    }
    return hooks.refs[index]
  })
  hooks.useState.mockImplementation((initial: unknown) => {
    const index = hooks.stateCursor
    hooks.stateCursor += 1
    if (index >= hooks.states.length) {
      hooks.states.push(
        typeof initial === 'function'
          ? (initial as () => unknown)()
          : initial,
      )
    }
    const setState = (next: unknown): void => {
      hooks.states[index] =
        typeof next === 'function'
          ? (next as (current: unknown) => unknown)(hooks.states[index])
          : next
    }
    return [hooks.states[index], setState]
  })
})

describe('CaptionList', () => {
  it('seeks to exact source time and highlights rows with half-open timing', () => {
    const onSeek = vi.fn()
    const atBoundary = renderList(6, onSeek)

    expect(captionText(atBoundary, 'First caption').props.style?.background).toBe(
      'transparent',
    )
    expect(
      captionText(atBoundary, 'Original SDK name').props.style?.background,
    ).toBe('var(--accent)')

    const timeButton = findHost(
      atBoundary,
      'button',
      (props) => textOf(props.children) === '1:05',
    )
    expect(timeButton.props.title).toBe('65.25s')
    timeButton.props.onClick?.()
    expect(onSeek).toHaveBeenCalledWith(65.25)

    const atEnd = renderList(8, onSeek)
    expect(
      captionText(atEnd, 'Original SDK name').props.style?.background,
    ).toBe('transparent')
  })

  it('commits the latest draft once through the Enter-to-blur path', () => {
    const onEditText = vi.fn()
    let view = renderList(6.5, vi.fn(), onEditText)
    captionText(view, 'Original SDK name').props.onClick?.()

    view = renderList(6.5, vi.fn(), onEditText)
    let input = findHost(view, 'input', () => true)
    expect(input.props.value).toBe('Original SDK name')
    input.props.onChange?.({ target: { value: 'Corrected SDK name' } })

    view = renderList(6.5, vi.fn(), onEditText)
    input = findHost(view, 'input', () => true)
    const blur = vi.fn()
    input.props.onKeyDown?.({ key: 'Enter', currentTarget: { blur } })
    expect(blur).toHaveBeenCalledOnce()

    input.props.onBlur?.()
    expect(onEditText).toHaveBeenCalledOnce()
    expect(onEditText).toHaveBeenCalledWith('second', 'Corrected SDK name')
  })

  it('cancels on Escape and suppresses the close-triggered blur commit', () => {
    const onEditText = vi.fn()
    let view = renderList(6.5, vi.fn(), onEditText)
    captionText(view, 'Original SDK name').props.onClick?.()

    view = renderList(6.5, vi.fn(), onEditText)
    let input = findHost(view, 'input', () => true)
    input.props.onChange?.({ target: { value: 'Discard this draft' } })

    view = renderList(6.5, vi.fn(), onEditText)
    input = findHost(view, 'input', () => true)
    input.props.onKeyDown?.({
      key: 'Escape',
      currentTarget: { blur: vi.fn() },
    })
    input.props.onBlur?.()

    expect(onEditText).not.toHaveBeenCalled()
    view = renderList(6.5, vi.fn(), onEditText)
    expect(captionText(view, 'Original SDK name')).toBeDefined()
  })
})
