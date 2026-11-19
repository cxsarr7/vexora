(function () {
  var KEY = "flagquest-v1";

  function empty() {
    return {
      sound: true,
      name: "",
      stats: {
        played: 0,
        correct: 0,
        answered: 0,
        bestStreak: 0,
        modes: {
          classic: { best: 0, plays: 0 },
          infinite: { best: 0, plays: 0 },
          timed: { best: 0, plays: 0 },
          world: { best: 0, plays: 0 }
        }
      },
      scores: [],
      resume: null
    };
  }

  function load() {
    var base = empty();
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!raw || typeof raw !== "object") return base;
      base.sound = raw.sound !== false;
      base.name = typeof raw.name === "string" ? raw.name : "";
      base.scores = Array.isArray(raw.scores) ? raw.scores : [];
      base.resume = raw.resume || null;
      if (raw.stats) {
        base.stats.played = raw.stats.played || 0;
        base.stats.correct = raw.stats.correct || 0;
        base.stats.answered = raw.stats.answered || 0;
        base.stats.bestStreak = raw.stats.bestStreak || 0;
        if (raw.stats.modes) {
          Object.keys(base.stats.modes).forEach(function (mode) {
            var saved = raw.stats.modes[mode] || {};
            base.stats.modes[mode] = {
              best: saved.best || 0,
              plays: saved.plays || 0
            };
          });
        }
      }
      return base;
    } catch (err) {
      return empty();
    }
  }

  function save(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  window.FQStore = { load: load, save: save, empty: empty };
})();
