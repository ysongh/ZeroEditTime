import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, SyntheticEvent } from 'react'

function App() {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  // Revoke the last object URL when it changes or on unmount, to avoid leaks.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
    }
  }, [])

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file === undefined) {
      return
    }

    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current)
    }

    const url = URL.createObjectURL(file)
    objectUrlRef.current = url
    setVideoUrl(url)
    setDuration(null)
  }

  function handleLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    setDuration(event.currentTarget.duration)
  }

  return (
    <>
      <h1>ZeroEditTime</h1>

      <input type="file" accept="video/*" onChange={handleFileChange} />

      {videoUrl !== null && (
        <div>
          <video
            src={videoUrl}
            controls
            onLoadedMetadata={handleLoadedMetadata}
            style={{ maxWidth: '100%', maxHeight: '70vh' }}
          />
          {duration !== null && <p>Duration: {duration.toFixed(2)} seconds</p>}
        </div>
      )}
    </>
  )
}

export default App
