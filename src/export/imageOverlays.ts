// Pure Phase-9A image-overlay export adaptation. This module translates the
// source-time overlay model into deterministic ffmpeg inputs and filter
// clauses; it does not touch ffmpeg's VFS, browser objects, React, or audio.

import type { EDL, Segment } from '../edl/types'
import {
  buildImageOverlayRenderPlan,
  type OverlayRenderSegment,
} from '../overlays/renderPlan'
import type { RemovedRange } from '../overlays/timing'
import type { ImageOverlay, OverlayAsset, OverlayFit } from '../overlays/types'

export interface ImageOverlayExportSettings {
  frameWidth: number
  frameHeight: number
  /** Label of the already-trimmed/concatenated video, without brackets. */
  inputVideoLabel?: string
  /** ffmpeg input index assigned to the first staged still image. */
  firstInputIndex?: number
}

/**
 * A generated, shell-safe VFS input plus the browser asset whose bytes the
 * runtime must write there. User-controlled values are deliberately metadata
 * only: none of them are used as an ffmpeg filename or filter label.
 */
export interface StagedImageOverlayAsset {
  assetId: string
  asset: OverlayAsset
  name: string
  src: string
  inputName: string
  inputIndex: number
}

export interface ImageOverlayFilterGraph {
  inputArgs: string[]
  filterComplex: string
  /** Assembled kept-video label consumed by `filterComplex`. */
  inputVideoLabel: string
  outputVideoLabel: string
  stagedAssets: StagedImageOverlayAsset[]
  frameWidth: number
  frameHeight: number
}

/**
 * Output-only interval consumed by the compositor. Source provenance stays in
 * the split `OverlayRenderSegment[]`; adjacent pieces may collapse here once a
 * cut has made them continuous on the exported clock.
 */
export type OverlayCompositeInterval = Omit<
  OverlayRenderSegment,
  'sourceStartMs' | 'sourceEndMs'
>

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * Derive source-time removals as the complement of the EDL's kept segments.
 * Kept segments are defensively clamped, sorted, and unioned first, so an
 * unsorted or overlapping EDL cannot create duplicate or negative gaps.
 */
export function deriveRemovedSourceRanges(
  edl: Pick<EDL, 'source' | 'segments'>,
): RemovedRange[] {
  const sourceEndMs = secondsToMilliseconds(edl.source.duration)
  if (sourceEndMs <= 0) {
    return []
  }

  const kept = normalizeKeptSegments(edl.segments, sourceEndMs)
  const removed: RemovedRange[] = []
  let cursor = 0

  for (const range of kept) {
    if (range.startMs > cursor) {
      removed.push({ startMs: cursor, endMs: range.startMs })
    }
    cursor = Math.max(cursor, range.endMs)
  }

  if (cursor < sourceEndMs) {
    removed.push({ startMs: cursor, endMs: sourceEndMs })
  }

  return removed
}

/** Build the current deterministic render plan directly from an EDL. */
export function buildImageOverlayRenderPlanForEdl(
  edl: Pick<EDL, 'source' | 'segments'>,
  overlays: readonly ImageOverlay[],
  assets: readonly OverlayAsset[],
): OverlayRenderSegment[] {
  return buildImageOverlayRenderPlan(
    overlays,
    assets,
    deriveRemovedSourceRanges(edl),
  )
}

/**
 * Collapse adjacent output-time pieces only when they are one visually
 * continuous logical overlay. The source-aware render plan remains untouched
 * and split around cuts; this output-only form avoids switching image branches
 * at a removed join, which could otherwise introduce a one-frame flash.
 *
 * A fade at either side of the join is treated as intentional and prevents a
 * merge. The first interval's fade-in and final interval's fade-out survive a
 * successful merge. A one-nanosecond tolerance absorbs floating-point noise
 * from seconds-to-milliseconds projection without bridging a visible gap.
 */
export function coalesceContinuousOverlaySegments(
  renderPlan: readonly OverlayRenderSegment[],
): OverlayCompositeInterval[] {
  const ordered = renderPlan
    .filter(isSurvivingSegment)
    .slice()
    .sort(compareRenderSegments)
  const intervals: OverlayCompositeInterval[] = []

  for (const segment of ordered) {
    const current = toCompositeInterval(segment)
    const previous = intervals.at(-1)
    if (previous !== undefined && canCoalesce(previous, current)) {
      intervals[intervals.length - 1] = {
        ...previous,
        outputEndMs: current.outputEndMs,
        fadeOutMs: current.fadeOutMs,
      }
    } else {
      intervals.push(current)
    }
  }

  return intervals
}

/**
 * Build the image-only portion of an ffmpeg graph.
 *
 * The caller supplies the label of its assembled kept-video stream and appends
 * these clauses to the existing filter graph. The returned image inputs are
 * looped stills, and `stagedAssets` says which browser asset to write to each
 * generated VFS name before ffmpeg executes. Audio is intentionally absent.
 *
 * An empty/non-surviving plan returns `null` before inspecting settings. This
 * gives the existing no-overlay export path a byte-identical fast path.
 */
export function buildImageOverlayFilterGraph(
  renderPlan: readonly OverlayRenderSegment[],
  assets: readonly OverlayAsset[],
  settings: ImageOverlayExportSettings,
): ImageOverlayFilterGraph | null {
  const orderedPlan = coalesceContinuousOverlaySegments(renderPlan)

  if (orderedPlan.length === 0) {
    return null
  }

  const frameWidth = normalizeEvenDimension(settings.frameWidth, 'width')
  const frameHeight = normalizeEvenDimension(settings.frameHeight, 'height')
  const inputVideoLabel = normalizeFilterLabel(
    settings.inputVideoLabel ?? 'ovbase',
  )
  const firstInputIndex = settings.firstInputIndex ?? 1
  if (!Number.isSafeInteger(firstInputIndex) || firstInputIndex < 1) {
    throw new Error(
      'Cannot export image overlays: firstInputIndex must be a positive safe integer.',
    )
  }

  const assetsById = new Map<string, OverlayAsset>()
  for (const asset of assets) {
    if (!assetsById.has(asset.id)) {
      assetsById.set(asset.id, asset)
    }
  }

  const stagedAssets: StagedImageOverlayAsset[] = []
  const stagedById = new Map<string, StagedImageOverlayAsset>()
  for (const segment of orderedPlan) {
    if (stagedById.has(segment.assetId)) {
      continue
    }

    const asset = assetsById.get(segment.assetId)
    if (asset === undefined) {
      throw new Error(
        `Cannot export image overlay: referenced asset "${segment.assetId}" is missing.`,
      )
    }

    const extension = extensionForMimeType(asset.mimeType)
    if (extension === null) {
      throw new Error(
        `Cannot export image asset "${asset.name}": unsupported MIME type "${asset.mimeType}".`,
      )
    }

    const numericIndex = stagedAssets.length
    const staged: StagedImageOverlayAsset = {
      assetId: asset.id,
      asset,
      name: asset.name,
      src: asset.src,
      inputName: `overlay_${numericIndex}.${extension}`,
      inputIndex: firstInputIndex + numericIndex,
    }
    stagedAssets.push(staged)
    stagedById.set(segment.assetId, staged)
  }

  const inputArgs = stagedAssets.flatMap((staged) => [
    '-loop',
    '1',
    '-i',
    staged.inputName,
  ])

  const useCounts = countAssetUses(orderedPlan)
  const nextUse = new Map<string, number>()
  const assetOrdinal = new Map(
    stagedAssets.map((staged, index) => [staged.assetId, index]),
  )
  const clauses: string[] = [
    `[${inputVideoLabel}]scale=${frameWidth}:${frameHeight},setsar=1[ovc0]`,
  ]

  for (const [index, staged] of stagedAssets.entries()) {
    const count = useCounts.get(staged.assetId) ?? 0
    if (count > 1) {
      const labels = Array.from(
        { length: count },
        (_, useIndex) => `[ovsrc${index}_${useIndex}]`,
      ).join('')
      clauses.push(`[${staged.inputIndex}:v]split=${count}${labels}`)
    }
  }

  for (let index = 0; index < orderedPlan.length; index++) {
    const segment = orderedPlan[index]
    const staged = stagedById.get(segment.assetId)
    const ordinal = assetOrdinal.get(segment.assetId)
    // Resolution above guarantees both lookups. Keep the guard so a future
    // refactor fails clearly rather than emitting an invalid `[undefined:v]`.
    if (staged === undefined || ordinal === undefined) {
      throw new Error('Cannot export image overlay: internal asset mapping failed.')
    }

    const useIndex = nextUse.get(segment.assetId) ?? 0
    nextUse.set(segment.assetId, useIndex + 1)
    const imageInput =
      (useCounts.get(segment.assetId) ?? 0) > 1
        ? `[ovsrc${ordinal}_${useIndex}]`
        : `[${staged.inputIndex}:v]`

    const rect = normalizedRectToPixels(
      segment,
      frameWidth,
      frameHeight,
    )
    const imageFilters = [
      'format=rgba',
      fitFilters(segment.fit, rect.width, rect.height),
      `colorchannelmixer=aa=${formatNumber(clampFinite(segment.opacity, 0, 1, 1))}`,
      ...alphaFadeFilters(segment),
    ]
    clauses.push(`${imageInput}${imageFilters.join(',')}[ovimg${index}]`)

    const previousVideoLabel = `ovc${index}`
    const outputVideoLabel =
      index === orderedPlan.length - 1 ? 'ovout' : `ovc${index + 1}`
    clauses.push(
      `[${previousVideoLabel}][ovimg${index}]overlay=` +
        `x=${rect.x}:y=${rect.y}:shortest=1:alpha=straight:` +
        `enable='gte(t,${formatSeconds(segment.outputStartMs)})*` +
        `lt(t,${formatSeconds(segment.outputEndMs)})'` +
        `[${outputVideoLabel}]`,
    )
  }

  return {
    inputArgs,
    filterComplex: clauses.join(';'),
    inputVideoLabel,
    outputVideoLabel: 'ovout',
    stagedAssets,
    frameWidth,
    frameHeight,
  }
}

function secondsToMilliseconds(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0
}

function normalizeKeptSegments(
  segments: readonly Segment[],
  sourceEndMs: number,
): RemovedRange[] {
  const sorted = segments
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start &&
        segment.end > 0 &&
        segment.start * 1_000 < sourceEndMs,
    )
    .map((segment) => ({
      startMs: clampFinite(segment.start * 1_000, 0, sourceEndMs, 0),
      endMs: clampFinite(
        segment.end * 1_000,
        0,
        sourceEndMs,
        sourceEndMs,
      ),
    }))
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const normalized: RemovedRange[] = []
  for (const range of sorted) {
    const previous = normalized.at(-1)
    if (previous !== undefined && range.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, range.endMs)
    } else {
      normalized.push({ ...range })
    }
  }
  return normalized
}

function isSurvivingSegment(segment: OverlayRenderSegment): boolean {
  return (
    Number.isFinite(segment.outputStartMs) &&
    Number.isFinite(segment.outputEndMs) &&
    segment.outputEndMs > segment.outputStartMs &&
    segment.outputEndMs > 0
  )
}

function compareRenderSegments(
  a: OverlayRenderSegment,
  b: OverlayRenderSegment,
): number {
  // DOM preview paints equal-z layers by overlay ID. Group by that ID before
  // timing here as well, so overlapping tied layers cannot change who is on top
  // merely because one begins earlier or was split around a cut.
  return (
    finiteOr(a.zIndex, 0) - finiteOr(b.zIndex, 0) ||
    compareText(a.overlayId, b.overlayId) ||
    a.outputStartMs - b.outputStartMs ||
    a.sourceStartMs - b.sourceStartMs ||
    a.outputEndMs - b.outputEndMs ||
    compareText(a.assetId, b.assetId)
  )
}

const OUTPUT_ADJACENCY_EPSILON_MS = 0.000_001

function canCoalesce(
  previous: OverlayCompositeInterval,
  current: OverlayCompositeInterval,
): boolean {
  return (
    previous.overlayId === current.overlayId &&
    previous.assetId === current.assetId &&
    Math.abs(previous.outputEndMs - current.outputStartMs) <=
      OUTPUT_ADJACENCY_EPSILON_MS &&
    current.outputEndMs > previous.outputEndMs &&
    previous.fadeOutMs === 0 &&
    current.fadeInMs === 0 &&
    previous.x === current.x &&
    previous.y === current.y &&
    previous.width === current.width &&
    previous.height === current.height &&
    previous.fit === current.fit &&
    previous.opacity === current.opacity &&
    previous.zIndex === current.zIndex
  )
}

function toCompositeInterval(
  segment: OverlayRenderSegment,
): OverlayCompositeInterval {
  return {
    overlayId: segment.overlayId,
    assetId: segment.assetId,
    outputStartMs: segment.outputStartMs,
    outputEndMs: segment.outputEndMs,
    x: segment.x,
    y: segment.y,
    width: segment.width,
    height: segment.height,
    fit: segment.fit,
    opacity: segment.opacity,
    zIndex: segment.zIndex,
    fadeInMs: segment.fadeInMs,
    fadeOutMs: segment.fadeOutMs,
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function extensionForMimeType(mimeType: string): string | null {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase()
  return MIME_EXTENSIONS[normalized] ?? null
}

function normalizeEvenDimension(value: number, axis: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot export image overlays: frame ${axis} is unavailable.`)
  }
  const integer = Math.floor(value)
  const even = integer - (integer % 2)
  if (even < 2) {
    throw new Error(
      `Cannot export image overlays: frame ${axis} must resolve to at least 2 pixels.`,
    )
  }
  return even
}

function normalizeFilterLabel(label: string): string {
  const normalized =
    label.startsWith('[') && label.endsWith(']') ? label.slice(1, -1) : label
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error('Cannot export image overlays: invalid base video label.')
  }
  if (/^ov(?:c\d+|img\d+|src\d+_\d+|out)$/.test(normalized)) {
    throw new Error(
      'Cannot export image overlays: base video label collides with generated labels.',
    )
  }
  return normalized
}

function countAssetUses(
  renderPlan: readonly OverlayCompositeInterval[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const segment of renderPlan) {
    counts.set(segment.assetId, (counts.get(segment.assetId) ?? 0) + 1)
  }
  return counts
}

interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

function normalizedRectToPixels(
  segment: OverlayCompositeInterval,
  frameWidth: number,
  frameHeight: number,
): PixelRect {
  const widthNormalized = clampFinite(segment.width, Number.EPSILON, 1, 1)
  const heightNormalized = clampFinite(segment.height, Number.EPSILON, 1, 1)
  const xNormalized = clampFinite(segment.x, 0, 1 - widthNormalized, 0)
  const yNormalized = clampFinite(segment.y, 0, 1 - heightNormalized, 0)

  const x = clampInteger(Math.round(xNormalized * frameWidth), 0, frameWidth - 1)
  const y = clampInteger(
    Math.round(yNormalized * frameHeight),
    0,
    frameHeight - 1,
  )
  const width = clampInteger(
    Math.round(widthNormalized * frameWidth),
    1,
    frameWidth - x,
  )
  const height = clampInteger(
    Math.round(heightNormalized * frameHeight),
    1,
    frameHeight - y,
  )

  return { x, y, width, height }
}

function fitFilters(fit: OverlayFit, width: number, height: number): string {
  switch (fit) {
    case 'cover':
      return (
        `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height}:(iw-ow)/2:(ih-oh)/2`
      )
    case 'stretch':
      return `scale=${width}:${height}`
    case 'contain':
    default:
      return (
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
      )
  }
}

function alphaFadeFilters(segment: OverlayCompositeInterval): string[] {
  const durationMs = segment.outputEndMs - segment.outputStartMs
  const fadeInMs = clampFinite(segment.fadeInMs, 0, durationMs, 0)
  const fadeOutMs = clampFinite(segment.fadeOutMs, 0, durationMs, 0)
  if (fadeInMs === 0 && fadeOutMs === 0) {
    return []
  }

  const fadeIn =
    fadeInMs === 0
      ? null
      : `fade=t=in:st=${formatSeconds(segment.outputStartMs)}:` +
        `d=${formatSeconds(fadeInMs)}:alpha=1`
  const fadeOut =
    fadeOutMs === 0
      ? null
      : `fade=t=out:st=${formatSeconds(segment.outputEndMs - fadeOutMs)}:` +
        `d=${formatSeconds(fadeOutMs)}:alpha=1`

  if (
    fadeIn !== null &&
    fadeOut !== null &&
    fadeInMs + fadeOutMs > durationMs
  ) {
    // Preview opacity is min(in-ramp, out-ramp). Running both alpha fades over
    // their overlap would multiply the ramps instead. Switch at their exact
    // crossover so precisely one ramp owns every frame, including the boundary.
    const crossoverMs =
      segment.outputStartMs +
      (fadeInMs * durationMs) / (fadeInMs + fadeOutMs)
    const crossover = formatSeconds(crossoverMs)
    return [
      `${fadeIn}:enable='lt(t,${crossover})'`,
      `${fadeOut}:enable='gte(t,${crossover})'`,
    ]
  }

  return [fadeIn, fadeOut].filter((filter): filter is string => filter !== null)
}

function formatSeconds(milliseconds: number): string {
  return formatNumber(milliseconds / 1_000)
}

function formatNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clampFinite(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  return Math.min(max, Math.max(min, finiteOr(value, fallback)))
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
