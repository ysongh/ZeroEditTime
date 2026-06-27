// Unit test for the transcribe proxy's pure Content-Type→extension helper. Lives
// one level ABOVE netlify/functions/ on purpose: every file directly inside the
// functions directory is bundled as its own Netlify Function, so a `*.test.ts`
// there would register a bogus "transcribe.test" endpoint. Vitest still discovers
// it here; Netlify ignores it.

import { describe, expect, it } from 'vitest'
import { extensionForContentType } from './functions/transcribe'

describe('extensionForContentType', () => {
  it('maps the audio types the Phase-2.5 extractor produces', () => {
    expect(extensionForContentType('audio/mpeg')).toBe('mp3')
    expect(extensionForContentType('audio/wav')).toBe('wav')
  })

  it('strips charset and ignores casing', () => {
    expect(extensionForContentType('AUDIO/MPEG; charset=binary')).toBe('mp3')
    expect(extensionForContentType('Audio/Wav')).toBe('wav')
  })

  it('maps common video and m4a types to supported extensions', () => {
    expect(extensionForContentType('video/mp4')).toBe('mp4')
    expect(extensionForContentType('audio/mp4')).toBe('m4a')
    expect(extensionForContentType('audio/webm')).toBe('webm')
  })

  it('defaults to mp3 for unknown, empty, or missing types', () => {
    expect(extensionForContentType(undefined)).toBe('mp3')
    expect(extensionForContentType('')).toBe('mp3')
    expect(extensionForContentType('application/octet-stream')).toBe('mp3')
  })
})
