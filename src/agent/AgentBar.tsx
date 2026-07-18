// The Phase-4 agent UI: a natural-language command box. On Run it executes the
// client agent loop against the current EDL + transcript and commits the result
// ONCE via App's `commitEdl` (so the whole command is a single Undo). The summary
// it shows — tools run and kept duration before→after — comes from the loop's
// CLIENT-computed numbers, not from Claude's text (which is optional flavor).

import { useState } from 'react'
import type { FormEvent, ChangeEvent } from 'react'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import { runAgent, type AgentRunResult } from './run'

type AgentBarProps = {
  edl: EDL
  transcript: Transcript
  // `regeneratedCaptions` lets App clear its hand-edited flag when a run
  // included generate_captions (which replaces any hand-edited caption text).
  onCommit: (edl: EDL, regeneratedCaptions: boolean) => void
}

function fmt(seconds: number): string {
  return seconds.toFixed(2)
}

function Summary({ result }: { result: AgentRunResult }) {
  const delta = result.keptBefore - result.keptAfter
  const duration = `Kept ${fmt(result.keptBefore)}s → ${fmt(result.keptAfter)}s (−${fmt(delta)}s)`

  if (result.toolsRun.length === 0) {
    return (
      <p style={{ marginTop: 8, fontSize: 14 }}>
        The agent made no edits. {duration}.
        {result.text !== '' && (
          <span style={{ color: '#666' }}> — {result.text}</span>
        )}
      </p>
    )
  }

  const tools = result.toolsRun
    .map((t) => `${t.name} (−${fmt(t.removed_seconds)}s)`)
    .join(', ')

  return (
    <div style={{ marginTop: 8, fontSize: 14, textAlign: 'left' }}>
      <p style={{ margin: '4px 0' }}>
        Ran {result.toolsRun.length} tool
        {result.toolsRun.length === 1 ? '' : 's'}: {tools}.
      </p>
      <p style={{ margin: '4px 0' }}>{duration}.</p>
      {result.text !== '' && (
        <p style={{ margin: '4px 0', color: '#666' }}>{result.text}</p>
      )}
    </div>
  )
}

export default function AgentBar({ edl, transcript, onCommit }: AgentBarProps) {
  const [command, setCommand] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AgentRunResult | null>(null)

  async function run() {
    const trimmed = command.trim()
    if (trimmed === '' || isRunning) {
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
    void run()
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setCommand(event.target.value)
  }

  return (
    <div style={{ marginTop: 16, textAlign: 'center' }}>
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', gap: 8, justifyContent: 'center' }}
      >
        <input
          type="text"
          value={command}
          onChange={handleChange}
          disabled={isRunning}
          placeholder='e.g. "remove the silences" or "get it under 30 seconds"'
          style={{ flex: '1 1 420px', maxWidth: 520, padding: '6px 8px' }}
        />
        <button type="submit" disabled={isRunning || command.trim() === ''}>
          {isRunning ? 'Thinking…' : 'Run'}
        </button>
      </form>

      {error !== null && (
        <p style={{ color: 'crimson', marginTop: 8, fontSize: 14 }}>{error}</p>
      )}

      {result !== null && <Summary result={result} />}
    </div>
  )
}
