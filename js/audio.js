(function () {
  var ctx = null;

  function ensure() {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!ctx) ctx = new AudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function beep(freq, delay, duration, type, volume) {
    var audio = ensure();
    if (!audio) return;
    var start = audio.currentTime + delay;
    var osc = audio.createOscillator();
    var gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function play(kind) {
    if (window.FQStore && window.FQStore.load().sound === false) return;
    if (kind === "ok") {
      beep(523, 0, 0.12, "sine", 0.06);
      beep(659, 0.08, 0.12, "sine", 0.06);
      beep(784, 0.16, 0.2, "triangle", 0.05);
      return;
    }
    if (kind === "bad") {
      beep(196, 0, 0.16, "sine", 0.05);
      beep(146, 0.1, 0.22, "sine", 0.04);
      return;
    }
    beep(660, 0, 0.05, "sine", 0.03);
  }

  window.FQAudio = {
    play: play,
    unlock: ensure
  };
})();
