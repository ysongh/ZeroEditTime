/**
 * Local Chrome check with actual generated media, shared FFmpeg, and MP4 exports.
 * Run pnpm dev --host 127.0.0.1 --port 4173 --strictPort, then:
 *   node scripts/verify-clarity-browser.mjs
 * Requires Chrome (CHROME_BIN overrides its macOS path) and network access to the
 * app's pinned FFmpeg CDN. No extra dependencies. Transcription and AI replies
 * are synthetic; no user recording, API credential, or live AI call is used.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseUrl = process.env.CLARITY_BROWSER_URL ?? 'http://127.0.0.1:4173'
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname), 'Use a local development server.')
const artifacts = await mkdtemp(join(tmpdir(), 'clarity-verification-'))
const profile = await mkdtemp(join(tmpdir(), 'clarity-chrome-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })
let launchError
chrome.on('error', (error) => { launchError = error })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket
try {
  let port
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch { await delay(100) }
  }
  assert(port, 'Chrome debugging endpoint did not start.')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  const exceptions = []
  let analyses = 0
  let transcriptions = 0
  function send(method, params = {}) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 120_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const words = [
    { text: 'Keep', start: 0, end: 0.5 }, { text: 'setup.', start: 0.5, end: 1 },
    { text: 'Repeat', start: 2, end: 2.5 }, { text: 'setup.', start: 2.5, end: 3 },
    { text: 'See', start: 4, end: 4.5 }, { text: 'result.', start: 4.5, end: 5 },
  ]
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.text)
    } else if (message.method === 'Fetch.requestPaused') {
      void fulfill(message.params).catch((error) => exceptions.push(error.message))
    }
  })
  async function fulfill({ requestId, request }) {
    const path = new URL(request.url).pathname
    let body
    let contentType = 'application/json'
    if (path === '/src/export/download.ts') {
      contentType = 'application/javascript'
      body = 'export function downloadBlob(blob){(window.__clarityExports??=[]).push(blob)}'
    } else if (path === '/api/transcribe') {
      transcriptions++
      body = JSON.stringify({ words })
    } else if (path === '/api/agent') {
      const requestBody = JSON.parse(request.postData)
      assert.equal(requestBody.mode, 'clarity-analysis')
      analyses++
      body = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_browser', name: 'submit_clarity_analysis', input: {
        suggestions: [{ sentenceId: 'sentence:2:3', reason: 'repeated-explanation', explanation: 'The setup is already explained.' }],
      } }], stop_reason: 'tool_use' })
    } else {
      await send('Fetch.continueRequest', { requestId })
      return
    }
    await send('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: contentType }], body: Buffer.from(body).toString('base64'),
    })
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  async function until(expression, seconds = 20) {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await delay(100)
    }
    throw new Error(`Timed out waiting for ${expression}`)
  }
  const clickText = async (text) => {
    const button = `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.closest('[hidden]'))`
    await until(`Boolean(${button}) && !(${button}).disabled`)
    return evaluate(`(${button}).click()`)
  }
  const check = async (expression, message) => assert(await evaluate(expression), message)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Fetch.enable', { patterns: [
    { urlPattern: '*/src/export/download.ts*' }, { urlPattern: '*/api/transcribe' }, { urlPattern: '*/api/agent' },
  ] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 1100, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: baseUrl })
  await until('document.querySelector("input[type=file]") !== null')
  console.log('Generating a 10-second video and tone with the app’s shared FFmpeg engine…')
  await evaluate(`(async()=>{
    const {loadFfmpeg,getFfmpeg,withFfmpegJob}=await import('/src/ffmpeg/engine.ts');
    await loadFfmpeg();const ffmpeg=getFfmpeg();
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#253050';ctx.fillRect(0,0,320,180);
    ctx.fillStyle='#52cfdf';ctx.fillRect(10,10,300,70);ctx.fillStyle='black';ctx.font='18px sans-serif';ctx.fillText('Clarity generated fixture',20,50);
    const png=new Uint8Array(await (await new Promise(r=>canvas.toBlob(r,'image/png'))).arrayBuffer());
    const rate=24000,samples=rate*10,buffer=new ArrayBuffer(44+samples*2),view=new DataView(buffer);
    const str=(at,s)=>[...s].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)));
    str(0,'RIFF');view.setUint32(4,36+samples*2,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,samples*2,true);
    for(let i=0;i<samples;i++)view.setInt16(44+i*2,Math.sin(i/rate*2*Math.PI*440)*5000,true);
    await withFfmpegJob(ffmpeg,async()=>{
      try{
        await ffmpeg.writeFile('clarity-fixture.png',png);await ffmpeg.writeFile('clarity-fixture.wav',new Uint8Array(buffer));
        const code=await ffmpeg.exec(['-loop','1','-i','clarity-fixture.png','-i','clarity-fixture.wav','-t','10','-r','15','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','clarity-fixture.mp4']);
        if(code!==0)throw new Error('Fixture encoding failed.');
        const bytes=await ffmpeg.readFile('clarity-fixture.mp4');
        const file=new File([bytes],'clarity-fixture.mp4',{type:'video/mp4'});
        const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('input[accept="video/*"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
      }finally{for(const name of ['clarity-fixture.png','clarity-fixture.wav','clarity-fixture.mp4'])await ffmpeg.deleteFile(name).catch(()=>{});}
    });
  })()`)
  await until('document.querySelector("video")?.readyState >= 2 && Number.isFinite(document.querySelector("video").duration)')
  await evaluate('document.querySelector("video").muted=true')
  await clickText('Transcribe')
  await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="Transcribe Again")', 60)
  await evaluate('document.getElementById("inspector-tab-captions").click()')
  await clickText('Generate Captions')
  await evaluate('document.getElementById("inspector-tab-clarity").click()')
  await clickText('Suggest clarity edits')
  await until('document.querySelector(".clarity-card") !== null')
  const initialDuration = await evaluate('document.querySelector("video").duration')
  await check('document.querySelector(".clarity-card__text").textContent === "Repeat setup."', 'Incorrect local sentence text.')
  await clickText('Preview edited version')
  await check('document.getElementById("clarity-panel-status").textContent.includes("Previewing selected cuts")', 'Preview did not start.')
  // Actual decode/seek/playback; neither currentTime nor media methods are mocked.
  // Require an actual seek to the next kept range. Simply waiting for time >= 3
  // would also pass if ordinary playback played straight through the cut.
  const previewSeek = await evaluate(`(async()=>{
    const video=document.querySelector('video');
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);video.removeEventListener('seeking',onSeeking);};
      const onSeeking=()=>{
        if(video.currentTime>=3&&video.currentTime<3.2){
          const destination=video.currentTime;cleanup();resolve({from:2.15,to:destination});
        }
      };
      const timer=setTimeout(()=>{cleanup();reject(new Error('Preview did not seek past the selected cut.'));},3000);
      video.addEventListener('seeking',onSeeking);video.currentTime=2.15;
    });
  })()`)
  await check('!document.querySelector("video").paused', 'Preview stopped before the retained sentence.')
  const desktop = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(join(artifacts, 'desktop.png'), Buffer.from(desktop.data, 'base64'))
  await clickText('Export MP4')
  await until('(window.__clarityExports?.length ?? 0) === 1', 90)
  await clickText('Apply selected cuts')
  await check('!document.querySelector(".clarity-card") && document.querySelector("video").paused', 'Apply did not clear review/stop preview.')
  await clickText('Export MP4')
  await until('window.__clarityExports.length === 2', 90)
  await evaluate('document.querySelector("button[aria-label=Undo]").click()')
  await clickText('Export MP4')
  await until('window.__clarityExports.length === 3', 90)
  const outputs = await evaluate(`(async()=>{
    const summaries=[];
    for(const [index,blob] of window.__clarityExports.entries()){
      const video=document.createElement('video');video.muted=true;const url=URL.createObjectURL(blob);video.src=url;
      await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Export cannot decode.'));});
      const audio=new AudioContext();const decoded=await audio.decodeAudioData(await blob.arrayBuffer());
      const samples=decoded.getChannelData(0);let energy=0;for(const sample of samples)energy+=sample*sample;
      summaries.push({index,bytes:blob.size,duration:video.duration,audioDuration:decoded.duration,channels:decoded.numberOfChannels,rms:Math.sqrt(energy/samples.length)});
      if(index===1){
        video.currentTime=0.5;await new Promise(r=>video.onseeked=r);
        const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);
        window.__clarityOutputFrame=canvas.toDataURL('image/png').split(',')[1];
      }
      URL.revokeObjectURL(url);await audio.close();
    }
    return summaries;
  })()`)
  for (const [index, output] of outputs.entries()) {
    const expected = initialDuration - (index === 1 ? 1 : 0)
    assert(Math.abs(output.duration - expected) < 0.15, `Export ${index} has incorrect duration.`)
    assert(Math.abs(output.audioDuration - output.duration) < 0.15, `Export ${index} audio/video durations differ.`)
    assert(output.rms > 0.01, `Export ${index} has no audible signal.`)
    const base64 = await evaluate(`(async()=>{const bytes=new Uint8Array(await window.__clarityExports[${index}].arrayBuffer());let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text)})()`)
    await writeFile(join(artifacts, `${['during-preview', 'after-apply', 'after-undo'][index]}.mp4`), Buffer.from(base64, 'base64'))
  }
  await writeFile(join(artifacts, 'after-apply-frame.png'), Buffer.from(await evaluate('window.__clarityOutputFrame'), 'base64'))
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate('document.getElementById("inspector-panel-clarity").scrollIntoView()')
  await check('document.documentElement.scrollWidth <= window.innerWidth', 'Mobile horizontal overflow.')
  const mobile = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(join(artifacts, 'mobile.png'), Buffer.from(mobile.data, 'base64'))
  assert.equal(analyses, 1, 'Unexpected background analysis.')
  assert.equal(transcriptions, 1, 'Unexpected transcription count.')
  assert.deepEqual(exceptions, [], 'Browser runtime errors.')
  const report = { result: 'passed', fixture: 'Generated static image + 440 Hz tone; synthetic transcript/model result', analyses, transcriptions, initialDuration, previewSeek, outputs, artifacts }
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  socket?.close()
  chrome.kill('SIGTERM')
}
