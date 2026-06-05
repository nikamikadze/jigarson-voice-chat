export class PcmPlayer {
  constructor({ onPlaybackStart } = {}) {
    this.ctx = null;
    this.nextTime = 0;
    this.sources = new Set();
    this.onPlaybackStart = onPlaybackStart;
    this.startedTurns = new Set();
  }

  ensure(sampleRate) {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.02);
  }

  enqueue(base64, sampleRate = 24000, turnId = 0) {
    this.ensure(sampleRate);
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer);
    const audioBuffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);
    source.onended = () => this.sources.delete(source);
    source.start(this.nextTime);
    if (!this.startedTurns.has(turnId)) {
      this.startedTurns.add(turnId);
      this.onPlaybackStart?.(turnId);
    }
    this.sources.add(source);
    this.nextTime += audioBuffer.duration;
  }

  stop() {
    for (const source of this.sources) {
      try { source.stop(); } catch {}
    }
    this.sources.clear();
    this.startedTurns.clear();
    if (this.ctx) this.nextTime = this.ctx.currentTime;
  }
}
