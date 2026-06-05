const DEFAULT_TARGET_RATE = 24000;

function downsample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function floatToPcm16(input) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

export class MicPcmStreamer {
  constructor({
    onChunk,
    onLevel,
    onState,
    onStats,
    onSpeechStart,
    onSpeechEnd,
    targetSampleRate = DEFAULT_TARGET_RATE,
    chunkMs = 40,
    vadEnabled = false,
    vadStartLevel = 0.018,
    vadEndLevel = 0.01,
    vadStartMs = 120,
    vadSilenceMs = 700
  } = {}) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.onState = onState;
    this.onStats = onStats;
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
    this.targetSampleRate = targetSampleRate;
    this.chunkSamples = Math.round(this.targetSampleRate * (chunkMs / 1000));
    this.pending = [];
    this.pendingSamples = 0;
    this.chunkMs = chunkMs;
    this.vadEnabled = vadEnabled;
    this.vadStartLevel = vadStartLevel;
    this.vadEndLevel = vadEndLevel;
    this.vadStartMs = vadStartMs;
    this.vadSilenceMs = vadSilenceMs;
    this.vadActive = false;
    this.vadSpeechMs = 0;
    this.vadSilenceAccumMs = 0;
    this.packetCount = 0;
    this.byteCount = 0;
    this.windowStartedAt = performance.now();
    this.firstChunkLogged = false;
    this.active = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.trackSettings = this.stream.getAudioTracks()[0]?.getSettings?.() || {};
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (event) => this.handleAudio(event.inputBuffer.getChannelData(0));
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    this.emitStats({
      phase: 'capture-start',
      inputSampleRate: this.ctx.sampleRate,
      inputChannels: this.trackSettings.channelCount || 1,
      inputFormat: 'Float32',
      outputSampleRate: this.targetSampleRate,
      outputChannels: 1,
      outputFormat: 'PCM16 little-endian',
      outputBitDepth: 16,
      chunkMs: this.chunkMs,
      expectedSamplesPerChunk: this.chunkSamples,
      trackSettings: this.trackSettings
    });
    this.onState?.('streaming');
  }

  handleAudio(input) {
    const resampled = downsample(input, this.ctx.sampleRate, this.targetSampleRate);
    if (!this.active) {
      this.emitLevel(new Float32Array(resampled.length));
      return;
    }

    this.emitLevel(resampled);
    this.pending.push(resampled);
    this.pendingSamples += resampled.length;

    while (this.pendingSamples >= this.chunkSamples) {
      const frame = new Float32Array(this.chunkSamples);
      let offset = 0;
      while (offset < frame.length) {
        const head = this.pending[0];
        const take = Math.min(head.length, frame.length - offset);
        frame.set(head.subarray(0, take), offset);
        offset += take;
        if (take === head.length) this.pending.shift();
        else this.pending[0] = head.subarray(take);
        this.pendingSamples -= take;
      }
      const pcm = floatToPcm16(frame);
      this.packetCount += 1;
      this.byteCount += pcm.byteLength;
      this.emitChunkStats(frame, pcm);
      this.onChunk?.(pcm);
      this.updateVad(frame);
    }
  }

  frameRms(samples) {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  updateVad(frame) {
    if (!this.vadEnabled) return;
    const rms = this.frameRms(frame);
    if (!this.vadActive) {
      this.vadSpeechMs = rms >= this.vadStartLevel ? this.vadSpeechMs + this.chunkMs : 0;
      if (this.vadSpeechMs >= this.vadStartMs) {
        this.vadActive = true;
        this.vadSilenceAccumMs = 0;
        this.onSpeechStart?.({ at: performance.now(), level: rms });
      }
      return;
    }

    if (rms <= this.vadEndLevel) {
      this.vadSilenceAccumMs += this.chunkMs;
    } else {
      this.vadSilenceAccumMs = 0;
    }
    if (this.vadSilenceAccumMs >= this.vadSilenceMs) {
      this.vadActive = false;
      this.vadSpeechMs = 0;
      this.vadSilenceAccumMs = 0;
      this.onSpeechEnd?.({ at: performance.now(), level: rms });
    }
  }

  emitLevel(samples) {
    this.onLevel?.(this.frameRms(samples));
  }

  emitChunkStats(frame, pcm) {
    const now = performance.now();
    let min = 1;
    let max = -1;
    let absSum = 0;
    for (const sample of frame) {
      if (sample < min) min = sample;
      if (sample > max) max = sample;
      absSum += Math.abs(sample);
    }
    const elapsedSec = Math.max(0.001, (now - this.windowStartedAt) / 1000);
    const stats = {
      phase: this.firstChunkLogged ? 'chunk' : 'first-chunk',
      inputSampleRate: this.ctx.sampleRate,
      inputChannels: this.trackSettings.channelCount || 1,
      inputFormat: 'Float32',
      outputSampleRate: this.targetSampleRate,
      outputChannels: 1,
      outputFormat: 'PCM16 little-endian',
      outputBitDepth: 16,
      expectedSampleRateSent: this.targetSampleRate,
      actualSampleRateSent: this.targetSampleRate,
      samplesPerChunk: frame.length,
      byteLength: pcm.byteLength,
      minSample: Number(min.toFixed(6)),
      maxSample: Number(max.toFixed(6)),
      averageAmplitude: Number((absSum / Math.max(1, frame.length)).toFixed(6)),
      packetsPerSecond: Number((this.packetCount / elapsedSec).toFixed(2)),
      bytesPerSecond: Math.round(this.byteCount / elapsedSec)
    };
    if (!this.firstChunkLogged) {
      console.log('[AUDIO CHUNK DEBUG]', stats);
      this.firstChunkLogged = true;
      this.emitStats(stats);
      return;
    }
    if (now - this.lastStatsAt > 1000 || !this.lastStatsAt) {
      this.lastStatsAt = now;
      this.emitStats(stats);
    }
  }

  emitStats(stats) {
    this.onStats?.(stats);
  }

  setActive(active) {
    this.active = Boolean(active);
    this.pending = [];
    this.pendingSamples = 0;
    this.vadActive = false;
    this.vadSpeechMs = 0;
    this.vadSilenceAccumMs = 0;
  }

  stop() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.ctx?.close();
    this.onState?.('stopped');
  }
}
