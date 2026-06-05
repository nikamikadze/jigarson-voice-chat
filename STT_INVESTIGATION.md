# Georgian STT Investigation

## Audio Pipeline

```text
Microphone
  -> getUserMedia audio track
  -> AudioContext / ScriptProcessorNode
  -> Float32 samples from inputBuffer.getChannelData(0)
  -> downsample(input, AudioContext.sampleRate, 24000)
  -> floatToPcm16() little-endian PCM16
  -> WebSocket binary frame to /realtime
  -> base64 input_audio_buffer.append
  -> OpenAI Realtime transcription session
```

Runtime values are printed by the browser and forwarded to the server as `[AUDIO DIAGNOSTICS]`.

Expected normal shape:

```text
Input device / AudioContext: usually 48000 Hz, 1 channel, Float32
After conversion: 24000 Hz, 1 channel, PCM16 little-endian, 16-bit
Chunk size: AUDIO_CHUNK_MS * 24000 samples/sec * 2 bytes/sample
Default chunk: 40 ms -> 960 samples -> 1920 bytes
```

## PCM Conversion

The converter clips each Float32 sample into `[-1, 1]`, scales negative values by `0x8000`, positive values by `0x7fff`, and writes with `DataView.setInt16(..., true)`, which is little-endian.

For the first captured chunk, the browser logs:

- `minSample`
- `maxSample`
- `averageAmplitude`
- `byteLength`
- `packetsPerSecond`
- `bytesPerSecond`

## Resampling

The current resampler is a simple averaging downsampler:

```js
const ratio = inputRate / outputRate;
const start = Math.floor(i * ratio);
const end = Math.min(input.length, Math.floor((i + 1) * ratio));
output[i] = average(input[start..end]);
```

It is true resampling to 24000 Hz when `AudioContext.sampleRate !== 24000`, but it is not a high-quality band-limited resampler.

## Diagnostics UI

Open:

```text
http://localhost:3000/
```

The main UI shows:

- input sample rate
- output sample rate
- channel count
- packet rate
- byte rate
- audio level meter

## Benchmark Mode

Open:

```text
http://localhost:3000/benchmark.html
```

Speak each displayed phrase once. The page records:

- expected phrase
- Realtime transcript
- confidence if OpenAI returns logprobs
- STT latency
- manual observation field

Run four passes:

```text
gpt-4o-mini-transcribe + language = ka
gpt-4o-mini-transcribe + language omitted
gpt-4o-transcribe + language = ka
gpt-4o-transcribe + language omitted
```

Set `OPENAI_TRANSCRIBE_INCLUDE_LOGPROBS=true` if logprobs are needed and supported for the selected realtime transcription model.

## Transcript Logs

Every finalized transcript logs:

```text
[TRANSCRIPT] <raw text>
[TRANSCRIPT LENGTH] <number of UTF-16 code units>
[STT LATENCY] <milliseconds>
```

## What This Can Prove

The instrumentation can distinguish:

- browser capture format mismatch
- incorrect PCM byte length
- clipped or near-silent audio
- wrong output sample rate
- low-quality browser resampling
- model/language configuration differences
- model-side Georgian recognition limits

Do not rank root causes until benchmark rows and audio diagnostics are collected from the target microphone/browser.
