/* Heavy waveform/BPM/silence analysis intentionally runs off the renderer UI thread. */
importScripts('audio-control-logic.js');
self.onmessage = ({ data: { id, samples, sampleRate } }) => {
  const source = new Float32Array(samples), buckets = 420, peaks = new Array(buckets);
  const hop = Math.max(1, Math.floor(source.length / buckets));
  for (let bucket = 0; bucket < buckets; bucket++) {
    let peak = 0; const end = Math.min(source.length, (bucket + 1) * hop);
    for (let i = bucket * hop; i < end; i++) peak = Math.max(peak, Math.abs(source[i]));
    peaks[bucket] = peak;
  }
  const { audibleStart, audibleEnd } = AudioControlLogic.detectSilenceBounds(source, sampleRate);
  const envelope = [], step = Math.max(1, Math.floor(sampleRate * .02));
  for (let at = 0; at + step < Math.min(source.length, sampleRate * 90); at += step) {
    let energy = 0; for (let i = at; i < at + step; i++) energy += Math.abs(source[i]); envelope.push(energy / step);
  }
  const average = envelope.reduce((a, b) => a + b, 0) / Math.max(1, envelope.length), hits = [];
  for (let i = 1; i < envelope.length - 1; i++) if (envelope[i] > average * 1.7 && envelope[i] > envelope[i - 1] && envelope[i] >= envelope[i + 1] && (!hits.length || i - hits[hits.length - 1] > 8)) hits.push(i);
  const intervals = [];
  for (let i = 1; i < hits.length; i++) { const bpm = 60 / ((hits[i] - hits[i - 1]) * .02); if (bpm >= 70 && bpm <= 190) intervals.push(bpm); }
  const bpm = intervals.length >= 4 ? intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)] : null;
  self.postMessage({ id, peaks, audibleStart, audibleEnd, bpm });
};
