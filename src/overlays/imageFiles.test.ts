import { describe, expect, it, vi } from 'vitest'
import {
  readImageDimensions,
  validateImageFile,
  type ImageDimensions,
} from './imageFiles'

describe('validateImageFile', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'])(
    'accepts %s',
    (type) => {
      expect(validateImageFile({ name: 'image', type })).toBeNull()
    },
  )

  it('rejects unsupported and missing MIME types with an actionable error', () => {
    expect(
      validateImageFile({ name: 'animation.gif', type: 'image/gif' }),
    ).toContain('PNG, JPEG, or WebP')
    expect(validateImageFile({ name: 'unknown.jpg', type: '' })).toContain(
      'unknown type',
    )
  })
})

describe('readImageDimensions', () => {
  function environment(
    decodeUrl: (url: string) => Promise<ImageDimensions>,
  ) {
    return {
      createObjectURL: vi.fn(() => 'blob:temporary'),
      revokeObjectURL: vi.fn(),
      decodeUrl: vi.fn(decodeUrl),
    }
  }

  it('returns decoded dimensions and revokes its temporary URL', async () => {
    const env = environment(async () => ({ width: 1920, height: 1080 }))

    await expect(
      readImageDimensions(new Blob(['image']), env),
    ).resolves.toEqual({ width: 1920, height: 1080 })
    expect(env.createObjectURL).toHaveBeenCalledOnce()
    expect(env.decodeUrl).toHaveBeenCalledWith('blob:temporary')
    expect(env.revokeObjectURL).toHaveBeenCalledWith('blob:temporary')
  })

  it('revokes its temporary URL when decoding fails', async () => {
    const env = environment(async () => {
      throw new Error('decode failed')
    })

    await expect(readImageDimensions(new Blob(['bad']), env)).rejects.toThrow(
      'decode failed',
    )
    expect(env.revokeObjectURL).toHaveBeenCalledWith('blob:temporary')
  })

  it('rejects invalid decoded dimensions and still revokes', async () => {
    const env = environment(async () => ({ width: 0, height: 100 }))

    await expect(readImageDimensions(new Blob(), env)).rejects.toThrow(
      'invalid dimensions',
    )
    expect(env.revokeObjectURL).toHaveBeenCalledWith('blob:temporary')
  })
})
