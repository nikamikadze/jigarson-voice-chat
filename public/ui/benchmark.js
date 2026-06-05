import { RealtimeSocket } from './socket.js';
import { MicPcmStreamer } from './mic-stream.js';

const phrases = [
  'გამარჯობა, როგორ ხარ?',
  'დღეს თბილისში კარგი ამინდია.',
  'შემიძლია ერთი შეკითხვა დაგისვა?',
  'მინდა სწრაფად და ბუნებრივად მელაპარაკო.',
  'ეს არის ქართული მეტყველების ტესტი.',
  'ხვალ დილით შეხვედრა გვაქვს.',
  'გთხოვ, მოკლედ მიპასუხე.',
  'რამდენი დრო დასჭირდება ამას?',
  'ახლა ვამოწმებთ ტრანსკრიფციის ხარისხს.',
  'მადლობა დახმარებისთვის.'
];

const els = {
  connection: document.querySelector('#connection'),
  provider: document.querySelector('#provider'),
  model: document.querySelector('#model'),
  language: document.querySelector('#language'),
  modelLabel: document.querySelector('#modelLabel'),
  languageLabel: document.querySelector('#languageLabel'),
  restart: document.querySelector('#restart'),
  expected: document.querySelector('#expected'),
  partial: document.querySelector('#partial'),
  final: document.querySelector('#final'),
  results: document.querySelector('#results'),
  audioDiagnostics: document.querySelector('#audioDiagnostics')
};

let socket;
let mic;
let index = 0;

els.provider.value = localStorage.benchmarkSttProvider || 'elevenlabs';
els.model.value = localStorage.benchmarkSttModel || 'gpt-4o-transcribe';
els.language.value = localStorage.benchmarkSttLanguage || 'ka';

function renderExpected() {
  els.expected.textContent = phrases[index] || 'Benchmark complete';
}

function renderAudioDiagnostics(stats) {
  els.audioDiagnostics.innerHTML = `
    <span>Input: ${stats.inputSampleRate ?? '-'} Hz, ${stats.inputChannels ?? '-'} ch, ${stats.inputFormat ?? '-'}</span>
    <span>Output: ${stats.outputSampleRate ?? '-'} Hz, ${stats.outputChannels ?? '-'} ch, ${stats.outputFormat ?? '-'}</span>
    <span>Packets/sec: ${stats.packetsPerSecond ?? '-'}</span>
    <span>Bytes/sec: ${stats.bytesPerSecond ?? '-'}</span>
  `;
}

function addResult(event) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${index + 1}</td>
    <td>${phrases[index] || ''}</td>
    <td>${event.text || ''}</td>
    <td>${event.confidence ?? 'n/a'}</td>
    <td>${event.sttLatencyMs ?? 'n/a'}ms</td>
    <td></td>
  `;
  els.results.appendChild(tr);
  index += 1;
  renderExpected();
}

async function start() {
  mic?.stop();
  els.results.innerHTML = '';
  els.partial.textContent = '';
  els.final.textContent = '';
  index = 0;
  renderExpected();

  const params = new URLSearchParams({
    mode: 'benchmark',
    sttProvider: els.provider.value,
    sttModel: els.model.value,
    sttLanguage: els.language.value
  });
  els.modelLabel.textContent = `${els.provider.value}: ${els.model.value}`;
  els.languageLabel.textContent = els.language.value === 'omit' ? 'language omitted' : 'language = ka';

  socket = new RealtimeSocket({
    sessionId: `benchmark-${crypto.randomUUID()}`,
    params,
    onEvent
  });
  socket.connect();
}

async function startMic(config = {}) {
  if (mic) return;
  mic = new MicPcmStreamer({
    chunkMs: config.chunkMs || 40,
    targetSampleRate: config.inputSampleRate || 24000,
    vadEnabled: Boolean(config.clientVad),
    vadStartLevel: config.clientVadStartLevel,
    vadEndLevel: config.clientVadEndLevel,
    vadStartMs: config.clientVadStartMs,
    vadSilenceMs: config.clientVadSilenceMs,
    onChunk: (buffer) => socket.sendBinary(buffer),
    onSpeechStart: (event) => socket.send({ type: 'client-speech-start', at: event.at, level: event.level }),
    onSpeechEnd: (event) => socket.send({ type: 'client-speech-end', at: event.at, level: event.level }),
    onStats: (stats) => {
      renderAudioDiagnostics(stats);
      socket.send({ type: 'audio-diagnostics', stats });
    }
  });
  await mic.start();
}

function onEvent(event) {
  if (event.type === 'ready') {
    els.connection.textContent = 'connected';
    startMic(event.audio).catch((err) => els.connection.textContent = err.message);
  }
  if (event.type === 'connection-state' && event.target === 'stt') {
    els.connection.textContent = `stt ${event.state}`;
  }
  if (event.type === 'stt-partial') els.partial.textContent = event.text;
  if (event.type === 'stt-final') {
    els.final.textContent = event.text;
    els.partial.textContent = '';
    addResult(event);
  }
  if (event.type === 'error') els.connection.textContent = event.message;
}

els.restart.addEventListener('click', () => location.reload());
els.provider.addEventListener('change', () => {
  localStorage.benchmarkSttProvider = els.provider.value;
  location.reload();
});

els.model.addEventListener('change', () => {
  localStorage.benchmarkSttModel = els.model.value;
  location.reload();
});
els.language.addEventListener('change', () => {
  localStorage.benchmarkSttLanguage = els.language.value;
  location.reload();
});

start();
