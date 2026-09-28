// The Phase-4 agent UI: a natural-language command box. On Run it executes the
// client agent loop against the current EDL + transcript and commits the result
// ONCE via App's `commitEdl` (so the whole command is a single Undo). The summary
// it shows — tools run and kept duration before→after — comes from the loop's
// CLIENT-computed numbers, not from Claude's text (which is optional flavor).

import { useState } from 'react'
import type { FormEvent, ChangeEvent } from 'react'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import Icon from '../ui/Icon'
import { formatClock, formatSeconds } from '../ui/time'
import { runAgent, type AgentRunResult, type AgentToolRun } from './run'

type AgentBarProps = {
  edl: EDL
  /** Null until the source is transcribed; the command box is disabled until then. */
  transcript: Transcript | null
  // `regeneratedCaptions` lets App clear its hand-edited flag when a run
  // included generate_captions (which replaces any hand-edited caption text).
  onCommit: (edl: EDL, regeneratedCaptions: boolean) => void
}

const SUGGESTIONS = [
  'Remove the silences',
  'Remove filler words',
  'Get it under 60 seconds',
] as const

const TOOL_LABELS: Readonly<Record<string, string>> = {
  cut_segment: 'Cut a range',
  remove_silences: 'Removed silences',
  remove_filler_words: 'Removed filler words',
  remove_stumbles: 'Removed stumbles',
  generate_captions: 'Generated captions',
  trim_to_duration: 'Trimmed to length',
}

function describeTool(tool: AgentToolRun): string {
  const label = TOOL_LABELS[tool.name] ?? tool.name
  const count = tool.removed_count > 0 ? ` ×${tool.removed_count}` : ''
  const removed =
    tool.removed_seconds > 0 ? ` (−${formatSeconds(tool.removed_seconds)})` : ''
  return `${label}${count}${removed}`
}

function Summary({ result }: { result: AgentRunResult }) {
  const delta = Math.max(0, result.keptBefore - result.keptAfter)
  const duration = `${formatClock(result.keptBefore)} → ${formatClock(result.keptAfter)} kept (−${formatSeconds(delta)})`
  const madeEdits = result.toolsRun.length > 0

  return (
    <div className="agent__result" role="status">
      {madeEdits && <Icon name="check" size={16} strokeWidth={2} />}
      <div className="agent__result-body">
        <p>
          {madeEdits
            ? `${result.toolsRun.map(describeTool).join(' · ')}.`
            : 'The agent made no edits.'}
        </p>
        <p>{duration}.</p>
        {result.text !== '' && (
          <p className="agent__narration">{result.text}</p>
        )}
      </div>
    </div>
  )
}

export default function AgentBar({ edl, transcript, onCommit }: AgentBarProps) {
  const [command, setCommand] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AgentRunResult | null>(null)

  const unavailable = transcript === null

  async function run(text: string) {
    const trimmed = text.trim()
    if (trimmed === '' || isRunning || transcript === null) {
      return
    }
    setIsRunning(true)
    setError(null)
    setResult(null)
    try {
      const outcome = await runAgent(trimmed, edl, transcript)
      const regeneratedCaptions = outcome.toolsRun.some(
        (t) => t.name === 'generate_captions',
      )
      onCommit(outcome.edl, regeneratedCaptions)
      setResult(outcome)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The agent run failed.')
    } finally {
      setIsRunning(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(command)
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setCommand(event.target.value)
  }

  function runSuggestion(suggestion: string) {
    setCommand(suggestion)
    void run(suggestion)
  }

  return (
    <section className="agent" aria-labelledby="agent-heading">
      <h2 id="agent-heading" className="eyebrow">
        Describe an edit
      </h2>
      <form className="agent__form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="text-input"
          aria-labelledby="agent-heading"
          value={command}
          onChange={handleChange}
          disabled={isRunning || unavailable}
          placeholder={
            unavailable
              ? 'Transcribe first to edit by describing'
              : 'e.g. “remove the silences”'
          }
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={isRunning || unavailable || command.trim() === ''}
        >
          {isRunning ? 'Working' : 'Run'}
        </button>
      </form>

      <div className="agent__suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="chip-btn"
            disabled={isRunning || unavailable}
            onClick={() => runSuggestion(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>

      {error !== null && (
        <p role="alert" className="error-text" style={{ fontSize: 13 }}>
          {error}
        </p>
      )}

      {result !== null && <Summary result={result} />}
    </section>
  )
}
