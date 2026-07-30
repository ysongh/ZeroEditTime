// Browser-side still-image validation and dimension decoding. Files never
// leave the browser and are never converted to base64.

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const

export const IMAGE_FILE_ACCEPT =
  '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp'

export interface ImageDimensions {
  width: number
  height: number
}

type ImageFileDescriptor = Pick<File, 'name' | 'type'>

type ImageDecodeEnvironment = {
  createObjectURL: (file: Blob) => string
  revokeObjectURL: (url: string) => void
  decodeUrl: (url: string) => Promise<ImageDimensions>
}

const SUPPORTED_MIME_TYPES = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES)

/** Return a user-facing validation error, or `null` for PNG/JPEG/WebP. */
export function validateImageFile(file: ImageFileDescriptor): string | null {
  if (!SUPPORTED_MIME_TYPES.has(file.type.toLowerCase())) {
    const type = file.type.trim() === '' ? 'unknown type' : file.type
    return `"${file.name}" is ${type}. Choose a PNG, JPEG, or WebP image.`
  }
  return null
}

/**
 * Decode dimensions through a short-lived object URL. The URL is revoked on
 * success and failure; the media panel creates the persistent asset URL only
 * after this function succeeds.
 */
export async function readImageDimensions(
  file: Blob,
  environment: ImageDecodeEnvironment = browserImageDecodeEnvironment,
): Promise<ImageDimensions> {
  const url = environment.createObjectURL(file)
  try {
    const dimensions = await environment.decodeUrl(url)
    if (
      !Number.isFinite(dimensions.width) ||
      !Number.isFinite(dimensions.height) ||
      dimensions.width <= 0 ||
      dimensions.height <= 0
    ) {
      throw new Error('The image has invalid dimensions.')
    }
    return dimensions
  } finally {
    environment.revokeObjectURL(url)
  }
}

const browserImageDecodeEnvironment: ImageDecodeEnvironment = {
  createObjectURL: (file) => URL.createObjectURL(file),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  decodeUrl: decodeImageUrl,
}

function decodeImageUrl(url: string): Promise<ImageDimensions> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      reject(
        new Error(
          'Could not read the image. It may be corrupted or use an unsupported encoding.',
        ),
      )
    }
    image.src = url
  })
}
