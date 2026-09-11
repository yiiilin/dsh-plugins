# @yiln-dsh/dsh-plugin-voice-input

A DSH Web bundle plugin that adds two-pass local voice input to the composer.

Speaking is recognized twice, by two different models:

1. **While you speak — a realtime model.** A streaming zipformer transducer
   decodes 16 kHz mono PCM as the browser sends it and publishes partial text,
   which is written straight into the composer draft. Words appear as you talk.
2. **After you stop — a non-realtime model.** The complete recording is decoded
   again by SenseVoice running in a worker thread, and that corrected text
   replaces the live hypothesis. This pass restores what streaming dropped at
   segment boundaries, fixes homophones, adds punctuation, and normalizes
   numbers (`早上九点` → `早上9点`, `fifty` → `50`).

Both models are local `sherpa-onnx` models on CPU. No audio, transcript, or API
key leaves the machine: this plugin talks to no speech service.

- Places one mic button in the composer's trailing cluster, ordered immediately
  left of the send/stop controls (`order` keeps it after the model seat and the
  context meter, which the product renders inside that cluster first).
- Click to start, click again to stop and correct. `Esc` cancels the recording
  and leaves the draft as it was.
- Appends to whatever is already in the composer instead of replacing it, and
  inserts a separating space only where the two languages need one.
- Asks for the microphone on the click itself, before any download, so a
  permission problem is reported immediately: a remembered denial, a
  permissions-policy block, a missing device, and a busy device each get their
  own message naming the browser's error.
- Shows download progress on the button during the one-time model fetch, and
  refuses to record with an actionable message when the microphone, the page
  origin, or a dependency is missing.
- Releases the microphone as soon as the Host is done — including when the Host
  ends the recording itself at `maxRecordingSeconds`.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: model provisioning, the realtime recognizer, the `/_dsh/voice-input/ws` upgrade route, and the `status` / `prepare` HTTP routes. |
| `offline-worker.js` | Worker thread that owns the non-realtime recognizer, so a corrective pass never blocks the daemon's event loop. |
| `client.js` | Browser bundle: the mic button, PCM capture at 16 kHz, and the draft writes through the session's own `inputActions` seat. |
| `cordis.patch.yml` | Web-profile composition patch for the Host row. |

## Install

The published package is `@yiln-dsh/dsh-plugin-voice-input@0.1.2`.

Local source directory:

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-voice-input
```

The plugin installs `sherpa-onnx-node` (onnxruntime, CPU) and `ws` as runtime
dependencies. Restart `dsh web` after installing or changing the bundle
composition.

## Models

Nothing is bundled; the two models are fetched on first use and cached:

| Pass | Model | Files |
| --- | --- | --- |
| Realtime | `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` | int8 encoder/decoder/joiner + tokens |
| Corrective | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` | int8 model + tokens |

They land in `$DSH_HOME/plugins/dsh-plugin-voice-input/models/` (~420 MB total)
and are downloaded from Hugging Face file by file, so an interrupted download
resumes at the next missing file. Both engines are warmed as soon as the fetch
finishes, so the first recording has no cold start.

Mic button click behavior when models are missing: the button becomes a spinner
with `正在下载语音模型 N%`, then a transient notice reports that the models are
ready and recording starts.

## Configuration

Edit the row in `$DSH_HOME/profiles/web/cordis.patch.yml` (or the bundle's own
patch) and restart `dsh web`:

```yaml
- id: dsh-voice-input
  config:
    streamingThreads: 2
    offlineThreads: 4
    language: auto
    maxRecordingSeconds: 300
```

| Option | Default | Meaning |
| --- | --- | --- |
| `modelRoot` | `$DSH_HOME/plugins/dsh-plugin-voice-input/models` | Where model files live. |
| `downloadBase` | `https://huggingface.co` | Model host; point it at a mirror when needed. |
| `streamingThreads` | `2` | CPU threads for the realtime recognizer (it runs continuously). |
| `offlineThreads` | `4` | CPU threads for the corrective recognizer (once per utterance). |
| `language` | `auto` | Corrective-model language hint (`zh`, `en`, `ja`, `ko`, `yue`, or `auto`). |
| `autoDownload` | `true` | Fetch missing models on the first recording attempt. With `false`, place the files yourself. |
| `maxRecordingSeconds` | `300` | Cap for one recording; reaching it finishes and corrects automatically. |
| `trailingSilenceSeconds` | `2.4` | Silence that closes a streaming segment into committed text. |

## Wire protocol

The browser opens `/_dsh/voice-input/ws` on the same authenticated origin as the
GUI. Frames are binary PCM (signed 16-bit little-endian, mono, 16 kHz) mixed
with JSON control frames:

| Direction | Frame | Meaning |
| --- | --- | --- |
| client → host | `{"type":"start"}` | Begin a streaming session. |
| client → host | `<binary>` | A PCM frame. |
| client → host | `{"type":"stop"}` | Finish and run the corrective pass. |
| client → host | `{"type":"cancel"}` | Discard the recording and its hypothesis. |
| host → client | `{"type":"hello",models,preparing}` | Session opened, with readiness. |
| host → client | `{"type":"partial",text}` | Full streaming hypothesis so far. |
| host → client | `{"type":"final",text,engine}` | `engine` is `offline` when the corrective pass produced the text. |
| host → client | `{"type":"progress",percent,stage}` | Model download progress. |
| host → client | `{"type":"capped",seconds}` | The recording cap was reached; a `final` follows. |
| host → client | `{"type":"error",code,message}` | Actionable failure. |

`POST /_dsh/voice-input/status` reports dependency and model readiness, and
`POST /_dsh/voice-input/prepare` starts the model fetch.

## Notes

- The microphone needs a secure context: browse the GUI over HTTPS, or over
  `http://localhost`. A plain-HTTP LAN address gives the button an explanatory
  error instead of a silent failure.
- Recognition is CPU work on the DSH host. The realtime pass costs roughly 5–15
  ms per 200 ms of audio on 8 cores; the corrective pass costs about 50 ms per
  second of recording and runs off the main thread.
- The corrective pass runs once per recording over the whole utterance, so
  `maxRecordingSeconds` also bounds how much audio is ever held in memory.
