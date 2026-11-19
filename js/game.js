(function () {
  var TRAPS = {
    td: ["ro"], ro: ["td"], mc: ["id"], id: ["mc", "pl"], pl: ["id", "mc"],
    ie: ["ci"], ci: ["ie"], nl: ["lu", "hr"], lu: ["nl"], hr: ["nl"],
    au: ["nz"], nz: ["au"], no: ["dk", "is"], dk: ["no", "is"], is: ["no", "dk"],
    be: ["de"], de: ["be"], it: ["mx", "hu", "ie"], mx: ["it"], hu: ["it", "bg"],
    bg: ["hu"], co: ["ec", "ve"], ec: ["co", "ve"], ve: ["co", "ec"],
    ru: ["sk", "si"], sk: ["si", "ru"], si: ["sk", "ru"],
    sn: ["ml"], ml: ["sn", "gn"], gn: ["ml"], ng: ["ie"],
    ar: ["uy"], uy: ["ar"], tn: ["tr"], tr: ["tn"], ma: ["vn"], vn: ["ma"],
    pe: ["at"], at: ["pe", "lv"], lv: ["at"], bh: ["qa"], qa: ["bh"],
    us: ["lr", "my"], lr: ["us"], my: ["us", "lr"], cg: ["cd"], cd: ["cg"],
    jo: ["ps"], ps: ["jo"], sd: ["ss"], ss: ["sd"], kp: ["kr"], kr: ["kp"],
    fi: ["se"], se: ["fi"], py: ["ar"], cm: ["gn"],
    aw: ["cw"], cw: ["aw", "sx"], sx: ["cw"],
    im: ["je", "gg"], je: ["gg", "im"], gg: ["je", "im"]
  };
  var ensigns = ["bm", "ky", "fk", "vg", "vi", "tc", "ai", "ms", "sh", "io", "pn", "gs", "ck"];
  ensigns.forEach(function (code) {
    TRAPS[code] = ensigns.filter(function (other) { return other !== code; }).slice(0, 3);
  });

  function shuffle(list) {
    var arr = list.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function byDifficulty(countries) {
    var bands = { 1: [], 2: [], 3: [] };
    countries.forEach(function (country) {
      var band = bands[country.difficulty] ? country.difficulty : 2;
      bands[band].push(country);
    });
    return {
      1: shuffle(bands[1]),
      2: shuffle(bands[2]),
      3: shuffle(bands[3])
    };
  }

  function balanced(countries, limit) {
    var bands = byDifficulty(countries);
    var weights = { 1: 0.4, 2: 0.35, 3: 0.25 };
    var counts = { 1: 0, 2: 0, 3: 0 };
    var order = [];
    var hardRun = 0;
    var cap = limit || (bands[1].length + bands[2].length + bands[3].length);
    while (order.length < cap) {
      var total = order.length + 1;
      var best = 0;
      var bestScore = -999;
      [1, 2, 3].forEach(function (level) {
        if (!bands[level].length) return;
        if (level === 3 && hardRun >= 1 && (bands[1].length || bands[2].length)) return;
        var score = weights[level] * total - counts[level] + Math.random() * 0.18;
        if (score > bestScore) {
          bestScore = score;
          best = level;
        }
      });
      if (!best) {
        if (bands[1].length) best = 1;
        else if (bands[2].length) best = 2;
        else if (bands[3].length) best = 3;
        else break;
      }
      order.push(bands[best].pop());
      counts[best] += 1;
      hardRun = best === 3 ? hardRun + 1 : 0;
    }
    return order;
  }

  function buildQueue(countries, mode) {
    if (mode === "classic") return balanced(countries, 10);
    return balanced(countries);
  }

  function takeOptions(list, options, used) {
    list.forEach(function (country) {
      if (options.length >= 4 || used[country.code]) return;
      options.push(country);
      used[country.code] = true;
    });
  }

  function makeQuestion(correct, countries) {
    var options = [correct];
    var used = {};
    used[correct.code] = true;
    var traps = shuffle((TRAPS[correct.code] || [])
      .map(function (code) {
        return countries.find(function (country) { return country.code === code; });
      })
      .filter(Boolean));
    if (traps.length) {
      options.push(traps[0]);
      used[traps[0].code] = true;
    }
    var pool = countries.filter(function (country) { return !used[country.code]; });
    takeOptions(shuffle(pool.filter(function (country) {
      return country.difficulty === correct.difficulty && country.region === correct.region;
    })), options, used);
    takeOptions(shuffle(pool.filter(function (country) {
      return country.difficulty === correct.difficulty;
    })), options, used);
    takeOptions(shuffle(pool.filter(function (country) {
      return Math.abs(country.difficulty - correct.difficulty) === 1 && country.region === correct.region;
    })), options, used);
    takeOptions(shuffle(pool.filter(function (country) {
      return country.region === correct.region;
    })), options, used);
    takeOptions(shuffle(pool), options, used);
    return { correct: correct, options: shuffle(options) };
  }

  function scoreAnswer(hit, elapsedMs, streak) {
    if (!hit) return { points: 0, streak: 0, speed: 0, streakBonus: 0 };
    var next = streak + 1;
    var speed = elapsedMs < 2000 ? 50 : elapsedMs < 4000 ? 30 : elapsedMs < 7000 ? 15 : 0;
    var streakBonus = Math.max(0, next - 1) * 10;
    return { points: 100 + speed + streakBonus, streak: next, speed: speed, streakBonus: streakBonus };
  }

  function flagSrc(code) {
    return "flags/" + code + ".png";
  }

  function flagFallback(code, step) {
    if (step === "png") return "https://flagcdn.com/w320/" + code + ".png";
    if (step === "svg") return "https://flagcdn.com/" + code + ".svg";
    return flagSrc(code);
  }

  function selfTest(countries) {
    var issues = [];
    var codes = {};
    countries.forEach(function (country) {
      if (codes[country.code]) issues.push("código repetido " + country.code);
      codes[country.code] = true;
      var question = makeQuestion(country, countries);
      var optionCodes = question.options.map(function (option) { return option.code; });
      if (optionCodes.length !== 4) issues.push("faltam opções " + country.code);
      if (new Set(optionCodes).size !== 4) issues.push("opções repetidas " + country.code);
      if (optionCodes.indexOf(country.code) === -1) issues.push("sem correta " + country.code);
    });
    ["classic", "infinite", "timed", "world"].forEach(function (mode) {
      var queue = buildQueue(countries, mode);
      var seen = {};
      queue.forEach(function (country) {
        if (seen[country.code]) issues.push(mode + " repetiu " + country.code);
        seen[country.code] = true;
      });
      if (mode === "classic" && queue.length !== 10) issues.push("clássico com " + queue.length);
      if (mode !== "classic" && queue.length !== countries.length) issues.push(mode + " com " + queue.length);
      var tally = { 1: 0, 2: 0, 3: 0 };
      queue.forEach(function (country, index) {
        tally[country.difficulty] += 1;
        if (index > 0 && country.difficulty === 3 && queue[index - 1].difficulty === 3 && index < 24) {
          issues.push(mode + " empilhou difícil em " + index);
        }
      });
      if (mode === "classic") {
        if (tally[1] < 3 || tally[1] > 5) issues.push("fáceis no clássico " + tally[1]);
        if (tally[2] < 2 || tally[2] > 5) issues.push("médias no clássico " + tally[2]);
        if (tally[3] < 2 || tally[3] > 4) issues.push("difíceis no clássico " + tally[3]);
      }
    });
    return issues;
  }

  window.FQGame = {
    shuffle: shuffle,
    buildQueue: buildQueue,
    makeQuestion: makeQuestion,
    scoreAnswer: scoreAnswer,
    flagSrc: flagSrc,
    flagFallback: flagFallback,
    selfTest: selfTest
  };
})();
