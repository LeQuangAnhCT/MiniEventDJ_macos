(function exposePlaybackTransitionGuard(root) {
  class PlaybackTransitionGuard {
    constructor() { this.generation = 0; }

    begin() {
      this.generation += 1;
      return this.generation;
    }

    isCurrent(token) {
      return token === this.generation;
    }

    schedule(token, callback, delay, schedule = setTimeout) {
      return schedule(() => {
        if (this.isCurrent(token)) callback();
      }, delay);
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = PlaybackTransitionGuard;
  else root.PlaybackTransitionGuard = PlaybackTransitionGuard;
})(typeof window !== 'undefined' ? window : globalThis);
