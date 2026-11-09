// Run from the repository with Node 25+:
//   node scripts/verify-clarity-live.mjs --dry-run  # local validation only
//   node scripts/verify-clarity-live.mjs            # one paid model request
//
// Uses only this synthetic transcript and the existing server relay. It does
// not upload a recording, modify editor content, retry, or log credentials.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import process from 'node:process'
import { createServer } from 'vite'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
assert(args.every((arg) => arg === '--dry-run'), 'Only --dry-run is supported.')
const dryRun = args.includes('--dry-run')

const sentences = [
  { role: 'setup', text: 'First create a project and choose the staging environment.' },
  { role: 'caveat', text: 'Keep the private API token on your server and never place it in browser code.' },
  { role: 'main-benefit', text: 'A preview link lets teammates review your changes before release.' },
  { role: 'repeated-explanation', text: 'Put another way the preview link allows your team to review changes before release.' },
  { role: 'tangent', text: 'My new green notebook has a bright cover and I bought it yesterday.' },
  { role: 'conclusion', text: 'Finally open the preview link and verify that the updated page renders correctly.' },
]

let sourceTime = 0
const transcript = { words: sentences.flatMap(({ text }) => {
  const words = text.split(' ').map((word) => {
    const start = sourceTime
    sourceTime += 0.25
    return { text: word, start, end: sourceTime }
  })
  sourceTime += 0.5
  return words
}) }
const draft = {
  targetDuration: '12',
  audience: 'Developers evaluating a staging preview workflow',
  mustStay: 'Preserve the setup steps, private-token safety caveat, main benefit, and final verification step.',
}

let server
let apiKey = ''
try {
  // Vite resolves the application's extensionless TypeScript imports without
  // adding another runner or opening an HTTP server. Disable env-file loading
  // here; the key is read only below for the explicit live invocation.
  server = await createServer({
    root: projectRoot,
    configFile: false,
    envFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const [review, edlMath, analysis, freshness, edit, relay] = await Promise.all([
    server.ssrLoadModule('/src/clarity/review.ts'),
    server.ssrLoadModule('/src/edl/edl.ts'),
    server.ssrLoadModule('/src/clarity/analysis.ts'),
    server.ssrLoadModule('/src/clarity/freshness.ts'),
    server.ssrLoadModule('/src/clarity/edit.ts'),
    server.ssrLoadModule('/netlify/functions/agent.ts'),
  ])
  const edl = edlMath.createEdl({
    id: 'clarity-live-synthetic', url: 'local:synthetic-demo', duration: sourceTime,
  })
  const before = JSON.stringify(edl)
  const prepared = review.prepareClarityReview(edl, transcript, draft)
  assert.equal(prepared.status, 'ready', 'The synthetic context must pass local preparation.')
  assert.equal(prepared.catalog.length, sentences.length, 'Expected one catalog entry per fixture sentence.')
  const snapshot = freshness.captureClaritySnapshot(edl, transcript, draft)

  if (dryRun) {
    console.log(JSON.stringify({
      check: 'clarity-live', mode: 'dry-run', networkRequests: 0,
      context: prepared.context,
    }, null, 2))
  } else {
    const envPath = resolve(projectRoot, '.env')
    if (existsSync(envPath)) process.loadEnvFile(envPath)
    apiKey = process.env.ANTHROPIC_API_KEY ?? ''
    assert(apiKey.trim() !== '', 'Set ANTHROPIC_API_KEY in the environment or repository .env before running the live check.')

    let networkRequests = 0
    let model
    const started = Date.now()
    const response = await relay.handleAgent({
      httpMethod: 'POST',
      body: JSON.stringify({ mode: analysis.CLARITY_ANALYSIS_MODE, context: prepared.context }),
    }, {
      apiKey,
      fetch: async (url, init) => {
        networkRequests += 1
        assert.equal(networkRequests, 1, 'The check must never retry or make a second model request.')
        assert.equal(url, 'https://api.anthropic.com/v1/messages', 'Unexpected upstream endpoint.')
        model = JSON.parse(init.body).model
        return fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
      },
    })
    assert.equal(networkRequests, 1, 'Expected exactly one model request.')
    const body = JSON.parse(response.body)
    if (response.statusCode !== 200) {
      const detail = typeof body.error === 'string' ? body.error.slice(0, 500) : 'No error detail returned.'
      throw new Error(`Clarity relay returned HTTP ${response.statusCode}: ${detail}`)
    }
    const result = analysis.extractClarityAnalysisResult(body, prepared.context)
    assert(result !== null, 'The live response did not pass client contract validation.')
    const selectedIds = result.suggestions.map(({ sentenceId }) => sentenceId)
    const derived = edit.deriveClarityEdit(edl, transcript, draft, { snapshot, result, selectedIds })
    assert.equal(derived.ok, true, 'The validated proposal could not be derived safely.')
    assert.equal(JSON.stringify(edl), before, 'Derivation must leave the original edit unchanged.')
    const removedIds = new Set(selectedIds)
    const essentials = prepared.catalog.flatMap((sentence, index) => {
      const role = sentences[index].role
      return ['setup', 'caveat', 'main-benefit', 'conclusion'].includes(role)
        ? [{ role, sentenceId: sentence.id, retained: !removedIds.has(sentence.id) }]
        : []
    })
    console.log(JSON.stringify({
      check: 'clarity-live', mode: 'live', model, networkRequests,
      elapsedMs: Date.now() - started,
      contractValidated: true,
      sourceDurationSeconds: edlMath.totalKeptDuration(edl),
      proposedDurationSeconds: edlMath.totalKeptDuration(derived.edl),
      targetDurationSeconds: prepared.context.settings.targetDurationSeconds,
      suggestions: result.suggestions.map((suggestion) => ({
        ...suggestion,
        text: prepared.catalog.find(({ id }) => id === suggestion.sentenceId).text,
      })),
      essentials,
      essentialsRetained: essentials.every(({ retained }) => retained),
      scope: 'One synthetic transcript. Inspect the suggestions; this does not establish general semantic quality, recording playback, or exported media quality.',
    }, null, 2))
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Clarity verification failed.'
  console.error(apiKey === '' ? message : message.replaceAll(apiKey, '[redacted]'))
  process.exitCode = 1
} finally {
  await server?.close()
}
