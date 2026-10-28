(function exposeAudioControlLogic(root) {
  function cuePosition(item, analysis, autoTrim) {
    if (item?.manualCue && Number.isFinite(item.cuePosition)) return Math.max(0, item.cuePosition);
    return autoTrim ? Math.max(0, Number(analysis?.audibleStart) || 0) : 0;
  }

  function trimEnd(analysis, duration, autoTrim) {
    const fullDuration = Math.max(0, Number(duration) || 0);
    if (!autoTrim || !fullDuration) return fullDuration;
    const detectedEnd = Number(analysis?.audibleEnd);
    return Number.isFinite(detectedEnd) && detectedEnd > 0 && detectedEnd < fullDuration
      ? detectedEnd
      : fullDuration;
  }

  function detectSilenceBounds(samples, sampleRate) {
    const source = samples || new Float32Array();
    const rate = Number(sampleRate) || 0;
    const duration = rate > 0 ? source.length / rate : 0;
    if (!source.length || !rate) return { audibleStart: 0, audibleEnd: duration };

    let maxPeak = 0;
    for (let index = 0; index < source.length; index += 1) {
      maxPeak = Math.max(maxPeak, Math.abs(source[index] || 0));
    }

    // Codec noise can be non-zero during silence, so use a sustained adaptive gate.
    const threshold = Math.max(0.035, Math.min(0.08, maxPeak * 0.06));
    const windowSize = Math.max(1, Math.floor(rate * 0.08));
    const requiredWindows = 3;
    // A file may intentionally contain a long silent lead-in (for example a
    // one-minute event cue), so scan the complete decoded track rather than
    // arbitrarily stopping after the first few seconds.  This runs in the
    // analysis worker, never on the UI thread.
    const scanLimit = source.length;
    const rmsAt = (start) => {
      let sum = 0;
      const end = Math.min(source.length, start + windowSize);
      for (let index = start; index < end; index += 1) sum += source[index] * source[index];
      return Math.sqrt(sum / Math.max(1, end - start));
    };

    let consecutiveAudible = 0;
    let audibleStart = 0;
    for (let at = 0; at + windowSize <= scanLimit; at += windowSize) {
      if (rmsAt(at) >= threshold) {
        consecutiveAudible += 1;
        if (consecutiveAudible >= requiredWindows) {
          audibleStart = Math.max(0, (at - (requiredWindows - 1) * windowSize) / rate);
          break;
        }
      } else consecutiveAudible = 0;
    }

    const tailStart = 0;
    let silentWindows = 0;
    let audibleEnd = duration;
    for (let at = source.length - windowSize; at >= tailStart; at -= windowSize) {
      if (rmsAt(at) < threshold) {
        silentWindows += 1;
        continue;
      }
      if (silentWindows >= requiredWindows) audibleEnd = Math.min(duration, (at + windowSize) / rate);
      break;
    }

    return { audibleStart, audibleEnd: Math.max(audibleStart, audibleEnd) };
  }

  function toneProfile(enabled) {
    return enabled
      // Gentle tonal shaping only. Large boosts can clip tracks that were
      // already mastered close to 0 dBFS.
      ? { low: 1.2, presence: 0.35, high: 0.7 }
      : { low: 0, presence: 0, high: 0 };
  }

  const api = { cuePosition, trimEnd, detectSilenceBounds, toneProfile };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudioControlLogic = api;
})(typeof window === 'undefined' ? globalThis : window);
