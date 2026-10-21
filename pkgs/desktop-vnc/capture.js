/**
 * desktop-vnc Host half — X desktop screenshot capture.
 *
 * `frame.jpg` and `stream.mjpg` cannot use the VNC socket: they exist so the
 * sidebar has a thumbnail before noVNC loads and a fallback when it cannot. Both
 * therefore shell out to ImageMagick's `import`, which is the only screenshot
 * tool proven present on this host (the bundled ffmpeg has no x11grab).
 *
 * `import` writes a JPEG on stdout, and JPEG bytes are not valid UTF-8: the
 * child is spawned with `stdout: 'pipe'` so the frame stays a raw byte stream.
 * The collect-mode reader would decode it to text and silently corrupt every
 * frame that contains an invalid sequence.
 *
 * In v2 the captured display is no longer the configured desktop but the nested
 * Xephyr display the browser stack reports, and that is only known at request
 * time — so {@link createCaptureService} exposes `setDisplay()` and every
 * capture reads the current value instead of a value frozen at construction.
 *
 * The runner is injected, so unit tests exercise the JPEG validation, the
 * multipart framing and the timer teardown without an X server.
 *
 * @module @yiln-dsh/dsh-desktop-vnc/capture
 */

/** A JPEG starts with SOI (FF D8) and ends with EOI (FF D9). */
export const JPEG_SOI = Buffer.from([0xff, 0xd8])
export const JPEG_EOI = Buffer.from([0xff, 0xd9])

/** Quality and frame-rate bounds the routes clamp client input to. */
export const MIN_QUALITY = 1
export const MAX_QUALITY = 100
export const MIN_FPS = 1
export const MAX_FPS = 15

/** Byte cap for one captured frame; a 1280x800 JPEG is far smaller. */
export const CAPTURE_MAX_BYTES = 8 * 1024 * 1024
/** One capture may take this long before it is abandoned. */
export const CAPTURE_TIMEOUT_MS = 8000

/** Clamp a user-supplied integer into `[min, max]`, falling back when unusable. */
export function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Strip anything that could be read as a flag from `display`. */
export function safeDisplay(value) {
  if (typeof value !== 'string') return ':0'
  const trimmed = value.trim()
  return /^:[0-9]{1,3}(\.[0-9]{1,3})?$/.test(trimmed) ? trimmed : ':0'
}

/** True when `body` looks like a complete JPEG rather than a truncated read. */
export function isJpeg(body) {
  if (!Buffer.isBuffer(body) || body.length < 4) return false
  return body.subarray(0, 2).equals(JPEG_SOI) && body.subarray(-2).equals(JPEG_EOI)
}

/** The argv that captures the root window of `display` as JPEG on stdout. */
export function importArgv(executable, { display, quality }) {
  return [
    executable,
    '-display', display,
    '-window', 'root',
    '-quality', String(quality),
    'jpeg:-',
  ]
}

/** One readable line for the panel; never a stack trace or a host path. */
export function describeCaptureError(error) {
  const text = typeof error?.message === 'string' ? error.message : String(error ?? '')
  if (error?.code === 'ENOENT' || /not found on PATH|is not an executable file/i.test(text)) {
    return 'import (ImageMagick) 未安装'
  }
  const first = text.split('\n')[0].trim()
  return first === '' ? 'desktop capture failed' : first.slice(0, 300)
}

/** Read a piped stream fully, bounded by `maxBytes`; resolves to the exact bytes. */
function drain(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    if (stream === undefined || stream === null) {
      resolve(Buffer.alloc(0))
      return
    }
    const chunks = []
    let total = 0
    let settled = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      // Detach ONLY this reader's listeners. `removeAllListeners()` would also
      // strip the ChildProcess-internal listener Node attaches to the piped
      // stream; without it the child's `close` event never fires, so the
      // caller's `handle.done` promise hangs until the capture timeout.
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('close', onEnd)
      stream.off('error', onError)
      stream.destroy?.()
      if (error !== undefined) reject(error)
      else resolve(value)
    }

    function onData(chunk) {
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += body.length
      if (total > maxBytes) {
        finish(new Error(`capture output exceeded ${maxBytes} bytes`))
        return
      }
      chunks.push(body)
    }
    function onEnd() {
      finish(undefined, Buffer.concat(chunks))
    }
    function onError(error) {
      finish(error)
    }

    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('close', onEnd)
    stream.once('error', onError)
  })
}

/**
 * Build the screenshot service shared by both capture routes.
 *
 * @param {object} options
 * @param {(spec: object) => object} options.spawn starts a child and returns a live handle (`done`/`terminate`).
 * @param {() => Promise<string>} [options.resolveExecutable] resolves the `import` binary.
 * @param {object} [options.config] plugin Config (display, jpegQuality).
 * @param {(level: string, message: string) => void} [options.log] diagnostic sink.
 * @param {number} [options.timeoutMs] per-capture budget.
 * @returns {{capture: (options?: {quality?: number}) => Promise<Buffer>, setDisplay: (value: string) => string, status: () => object}} service.
 */
export function createCaptureService({
  spawn,
  resolveExecutable,
  config = {},
  log,
  timeoutMs = CAPTURE_TIMEOUT_MS,
} = {}) {
  // Mutable: the browser stack picks the nested display lazily, so the routes
  // retarget this service through setDisplay() once it is known.
  let display = safeDisplay(config.display)
  // The display's access control is on, so the screenshot tool has to present the
  // same cookie the browser does. Without this every capture is refused with
  // "no authorization protocol specified", which reaches the panel as a 503.
  let authority = null
  const defaultQuality = clampInt(config.jpegQuality, MIN_QUALITY, MAX_QUALITY, 72)

  let executablePromise = null

  const note = (level, message) => {
    if (typeof log === 'function') {
      try {
        log(level, message)
      } catch {
        // Diagnostics must never break a capture.
      }
    }
  }

  const resolveImport = () => {
    if (typeof resolveExecutable !== 'function') return Promise.resolve('import')
    if (executablePromise === null) {
      executablePromise = Promise.resolve()
        .then(() => resolveExecutable('import'))
        .catch((error) => {
          executablePromise = null
          throw error
        })
    }
    return executablePromise
  }

  /** Capture one frame; rejects with a readable message the routes turn into 503. */
  const capture = async ({ quality } = {}) => {
    const q = clampInt(quality, MIN_QUALITY, MAX_QUALITY, defaultQuality)
    if (typeof spawn !== 'function') throw new Error('subprocess service unavailable')

    let executable
    try {
      executable = await resolveImport()
    } catch (error) {
      throw new Error(describeCaptureError(error))
    }

    let handle
    try {
      handle = spawn({
        argv: importArgv(executable, { display, quality: q }),
        cwd: '/tmp',
        ...(authority === null ? {} : { env: { DISPLAY: display, XAUTHORITY: authority } }),
        stdio: {
          stdin: 'ignore',
          // Raw bytes, not the UTF-8 text a collect reader would hand back.
          stdout: 'pipe',
          stderr: { maxBytes: 4096 },
        },
        graceMs: timeoutMs,
      })
    } catch (error) {
      throw new Error(describeCaptureError(error))
    }

    let timer = null
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          handle.terminate?.()
        } catch {
          // Already gone.
        }
        reject(new Error(`import timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
    })

    try {
      const [outcome, body] = await Promise.race([
        Promise.all([Promise.resolve(handle.done), drain(handle.stdout, CAPTURE_MAX_BYTES)]),
        timeout.then(() => {
          throw new Error(`import timed out after ${timeoutMs}ms`)
        }),
      ])
      const stderr = readCollected(handle, 'stderr')
      if (outcome?.exitCode !== 0) {
        const reason = describeCaptureError(new Error(stderr || `import exited with code ${outcome?.exitCode}`))
        note('warn', `desktop-vnc: capture failed: ${reason}`)
        throw new Error(reason)
      }
      if (!isJpeg(body)) {
        // A clean exit with an unusable body is still a failed capture: handing a
        // truncated or non-image buffer to the browser would corrupt the preview.
        const reason = 'import produced no usable JPEG frame'
        note('warn', `desktop-vnc: capture failed: ${reason}${stderr === '' ? '' : ` (${stderr})`}`)
        throw new Error(reason)
      }
      return body
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('import ')) throw error
      throw new Error(describeCaptureError(error))
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  return {
    capture,
    /**
     * Point subsequent captures at another display (the nested one in v2).
     * Returns the sanitized display actually stored; an unusable value keeps
     * the previous display rather than silently reverting to `:0`.
     */
    setAuthority: (value) => {
      if (typeof value !== 'string' || value.trim() === '') return authority
      authority = value.trim()
      return authority
    },
    setDisplay: (value) => {
      if (typeof value !== 'string') return display
      const trimmed = value.trim()
      if (!/^:[0-9]{1,3}(\.[0-9]{1,3})?$/.test(trimmed)) return display
      display = trimmed
      return display
    },
    status: () => ({ display, quality: defaultQuality }),
  }
}

/** Collected stderr text of a finished handle, trimmed to one diagnostic line. */
function readCollected(handle, stream) {
  const reader = handle?.collected?.[stream]
  if (reader === undefined || reader === null) return ''
  try {
    return reader.readFrom(0).text.trim()
  } catch {
    return ''
  }
}

/**
 * Stream MJPEG frames on one HTTP response until the client goes away.
 *
 * The timer is the whole contract here: every `multipart/x-mixed-replace`
 * response owns one interval, and `close`/`aborted`/write failure must clear it
 * or a closed sidebar tab keeps screenshotting the desktop forever.
 *
 * @param {object} options
 * @param {import('node:http').ServerResponse} options.res response to stream on.
 * @param {() => Promise<Buffer>} options.capture one-shot frame capture.
 * @param {number} [options.fps] frames per second.
 * @param {number} [options.quality] JPEG quality for each frame.
 * @param {(level: string, message: string) => void} [options.log] diagnostic sink.
 * @returns {{stop: () => void, boundary: string, started: boolean}} handle exposing an explicit stop.
 */
export function streamMjpeg({ res, capture, fps = 8, quality = 72, log }) {
  const boundary = `dshvnc${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`
  const interval = Math.max(1000 / MAX_FPS, 1000 / clampInt(fps, MIN_FPS, MAX_FPS, 8))
  const qualityValue = clampInt(quality, MIN_QUALITY, MAX_QUALITY, 72)

  res.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    connection: 'close',
    'x-accel-buffering': 'no',
  })

  let timer = null
  let stopped = false
  let inFlight = false
  let noted = false

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const noteOnce = (error) => {
    if (noted) return
    noted = true
    if (typeof log === 'function') {
      try {
        log('warn', `desktop-vnc: mjpeg stopped: ${describeCaptureError(error)}`)
      } catch {
        // ignore
      }
    }
  }

  const writeFrame = async () => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const body = await capture({ quality: qualityValue })
      if (stopped || res.writableEnded === true || res.destroyed === true) return
      res.write(Buffer.from(
        `--${boundary}\r\ncontent-type: image/jpeg\r\ncontent-length: ${body.length}\r\n\r\n`,
        'utf8',
      ))
      res.write(body)
      res.write('\r\n')
    } catch (error) {
      noteOnce(error)
      stop()
      if (res.writableEnded !== true && res.destroyed !== true) res.end()
    } finally {
      inFlight = false
    }
  }

  const onGone = () => stop()
  res.on('close', onGone)
  res.on('error', onGone)
  if (res.req !== undefined && res.req !== null && typeof res.req.on === 'function') {
    res.req.on('aborted', onGone)
  }

  // First frame immediately, then on the interval.
  timer = setInterval(() => {
    void writeFrame()
  }, interval)
  timer.unref?.()
  void writeFrame()

  return {
    stop,
    boundary,
    get started() {
      return !stopped
    },
  }
}
