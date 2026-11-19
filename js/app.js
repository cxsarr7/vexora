(function () {
  var MODE = {
    classic: "Clássico",
    infinite: "Infinito",
    timed: "Contra o tempo",
    world: "Desafio mundial"
  };
  var LEVEL = { 1: "Costa conhecida", 2: "Mar aberto", 3: "Arquipélago difícil" };
  var PRAISE = ["Isso!", "No mapa!", "Precisão.", "Bandeira certa.", "Olho clínico."];
  var DEMO = [
    { name: "Navegadora Demo", mode: "classic", score: 1540, accuracy: 100, streak: 10 },
    { name: "Atlas Demo", mode: "classic", score: 1210, accuracy: 80, streak: 5 },
    { name: "Bússola Demo", mode: "timed", score: 1860, accuracy: 92, streak: 8 },
    { name: "Equador Demo", mode: "timed", score: 980, accuracy: 70, streak: 4 },
    { name: "Meridiano Demo", mode: "infinite", score: 2400, accuracy: 88, streak: 12 },
    { name: "Rosa-dos-ventos Demo", mode: "world", score: 8600, accuracy: 76, streak: 9 }
  ];

  var store = FQStore.load();
  var countries = [];
  var learnBuilt = false;
  var rankFilter = "all";
  var state = blankState();
  var ui = {};

  function blankState() {
    return {
      view: "home",
      mode: null,
      queue: [],
      index: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      correct: 0,
      wrong: 0,
      times: [],
      speedTotal: 0,
      lap: 1,
      locked: false,
      over: false,
      question: null,
      questionShownAt: 0,
      timerId: null,
      auto: null,
      revealTimer: null,
      timerEnds: 0,
      remainingMs: 60000,
      notice: ""
    };
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function pts(value) {
    return Number(value || 0).toLocaleString("pt-BR");
  }

  function grab() {
    [
      "playerName", "homeStats", "homeRecord", "continueBox", "quizMode",
      "levelPill", "scoreStat", "streakStat", "streakBox", "timerBox",
      "timerStat", "bar", "progressLabel", "stage", "flag", "feedback",
      "options", "nextBtn", "stopBtn", "lapNote", "resultsMount", "rankMount",
      "rankChips", "rankWho", "wipeBtn", "learnSearch", "learnChips",
      "learnGrid", "learnEmpty", "blindToggle", "soundToggle", "live", "fx",
      "atlasNote", "bootError"
    ].forEach(function (id) {
      ui[id] = document.getElementById(id);
    });
  }

  function loadCountries() {
    var seen = {};
    countries = (window.FQ_COUNTRIES || []).map(function (row) {
      return {
        code: row[0],
        name: row[1],
        region: row[2],
        difficulty: Number(row[3]) || 2,
        capital: row[4]
      };
    }).filter(function (country) {
      if (!country.code || seen[country.code]) return false;
      seen[country.code] = true;
      return true;
    });
  }

  function cleanupTimers() {
    clearInterval(state.timerId);
    clearTimeout(state.auto);
    clearTimeout(state.revealTimer);
    state.timerId = null;
    state.auto = null;
    state.revealTimer = null;
  }

  function show(view) {
    state.view = view;
    document.body.dataset.screen = view;
    document.querySelectorAll(".view").forEach(function (section) {
      var on = section.dataset.view === view;
      section.hidden = !on;
      section.classList.toggle("is-on", on);
    });
    document.querySelectorAll("nav [data-go]").forEach(function (button) {
      button.classList.toggle("is-current", button.dataset.go === view);
    });
    if (view === "home") renderHome();
    if (view === "modes") renderModes();
    if (view === "ranking") renderRanking();
    if (view === "learn") ensureLearn();
    document.dispatchEvent(new CustomEvent("vexora:view", { detail: view }));
    window.scrollTo(0, 0);
  }

  function renderHome() {
    var stats = store.stats;
    var rate = stats.answered ? Math.round((stats.correct / stats.answered) * 100) + "%" : "—";
    var best = 0;
    Object.keys(stats.modes).forEach(function (mode) {
      best = Math.max(best, stats.modes[mode].best || 0);
    });
    ui.homeStats.replaceChildren(
      statTile("Bandeiras", countries.length),
      statTile("Partidas", stats.played),
      statTile("Aproveitamento", rate),
      statTile("Melhor sequência", stats.bestStreak)
    );
    ui.homeRecord.textContent = best
      ? "Recorde pessoal: " + pts(best) + " pts"
      : "Seu primeiro recorde começa agora.";
  }

  function statTile(label, value) {
    var tile = el("div", "tile");
    tile.appendChild(el("span", "", label));
    tile.appendChild(el("strong", "", String(value)));
    return tile;
  }

  function renderModes() {
    document.querySelectorAll("[data-best]").forEach(function (node) {
      var best = store.stats.modes[node.dataset.best].best;
      node.textContent = best ? "Recorde " + pts(best) + " pts" : "Sem recorde ainda";
    });
    ui.continueBox.replaceChildren();
    if (store.resume && store.resume.queue && store.resume.queue.length && MODE[store.resume.mode]) {
      var savedCount = (store.resume.correct || 0) + (store.resume.wrong || 0);
      var button = el("button", "continue", "Continuar " + MODE[store.resume.mode] + " · " + savedCount + " respondidas");
      button.type = "button";
      button.addEventListener("click", function () {
        startGame(store.resume.mode, true);
      });
      ui.continueBox.appendChild(button);
    }
  }

  function persistResume() {
    if (state.mode !== "world" && state.mode !== "infinite") return;
    if (state.correct + state.wrong === 0) return;
    store.resume = {
      mode: state.mode,
      queue: state.queue.map(function (country) { return country.code; }),
      index: state.locked ? state.index + 1 : state.index,
      score: state.score,
      streak: state.streak,
      bestStreak: state.bestStreak,
      correct: state.correct,
      wrong: state.wrong,
      times: state.times.slice(),
      speedTotal: state.speedTotal,
      lap: state.lap
    };
    FQStore.save(store);
  }

  function leaveQuiz() {
    if (state.view !== "quiz" || state.over) return;
    cleanupTimers();
    if (state.locked) {
      state.index += 1;
      state.locked = false;
    }
    if (state.mode === "timed" || (state.index >= state.queue.length && state.mode !== "infinite")) {
      finish();
      return;
    }
    if (state.index >= state.queue.length) {
      finish();
      return;
    }
    persistResume();
  }

  function startGame(mode, resume) {
    cleanupTimers();
    var previous = state;
    state = blankState();
    state.mode = mode;
    if (!MODE[mode] || countries.length < 4) return;
    if (resume && store.resume && store.resume.mode === mode) {
      var saved = store.resume;
      var map = {};
      countries.forEach(function (country) { map[country.code] = country; });
      state.queue = (saved.queue || []).map(function (code) { return map[code]; }).filter(Boolean);
      state.index = saved.index || 0;
      state.score = saved.score || 0;
      state.streak = saved.streak || 0;
      state.bestStreak = saved.bestStreak || 0;
      state.correct = saved.correct || 0;
      state.wrong = saved.wrong || 0;
      state.times = saved.times || [];
      state.speedTotal = saved.speedTotal || 0;
      state.lap = saved.lap || 1;
    } else {
      state.queue = FQGame.buildQueue(countries, mode);
      if (store.resume && store.resume.mode === mode) {
        store.resume = null;
        FQStore.save(store);
      }
    }
    if (!state.queue.length) return;
    if (state.index >= state.queue.length) {
      finish();
      return;
    }
    if (mode === "timed") {
      state.remainingMs = 60000;
      state.timerEnds = performance.now() + state.remainingMs;
      state.timerId = setInterval(tick, 100);
    }
    if (previous) FQAudio.play("tap");
    show("quiz");
    renderQuestion();
  }

  function tick() {
    if (state.over || state.mode !== "timed") return;
    state.remainingMs = Math.max(0, state.timerEnds - performance.now());
    renderTimer();
    if (state.remainingMs <= 0) finish();
  }

  function renderTimer() {
    var seconds = Math.ceil(state.remainingMs / 1000);
    ui.timerStat.textContent = seconds + "s";
    ui.timerBox.classList.toggle("urgent", seconds <= 10 && seconds > 0);
    ui.bar.style.width = Math.max(0, (state.remainingMs / 60000) * 100) + "%";
  }

  function renderHud() {
    ui.scoreStat.textContent = pts(state.score);
    ui.streakStat.textContent = String(state.streak);
    ui.streakBox.classList.toggle("hot", state.streak >= 2);
    ui.quizMode.textContent = MODE[state.mode] || "";
    ui.timerBox.hidden = state.mode !== "timed";
    if (state.question) ui.levelPill.textContent = LEVEL[state.question.correct.difficulty] || "Mar aberto";
  }

  function renderProgress() {
    if (state.mode === "timed") {
      renderTimer();
      var shown = state.correct + state.wrong + (state.locked ? 0 : 1);
      ui.progressLabel.textContent = shown + "ª bandeira · " + Math.ceil(state.remainingMs / 1000) + "s";
      return;
    }
    var total = state.queue.length || 1;
    var current = Math.min(total, state.index + 1);
    ui.bar.style.width = Math.min(100, (current / total) * 100) + "%";
    ui.progressLabel.textContent = "Bandeira " + current + " de " + total;
  }

  function renderQuestion() {
    var country = state.queue[state.index];
    if (!country) {
      finish();
      return;
    }
    clearTimeout(state.revealTimer);
    state.locked = false;
    state.questionShownAt = 0;
    state.question = FQGame.makeQuestion(country, countries);
    ui.stage.classList.remove("is-right", "is-wrong");
    ui.feedback.hidden = true;
    ui.feedback.textContent = "";
    ui.nextBtn.hidden = true;
    ui.lapNote.hidden = !state.notice;
    ui.lapNote.textContent = state.notice || "";
    state.notice = "";
    ui.flag.classList.remove("is-in");
    ui.flag.alt = "Bandeira para identificar";
    function revealFlag() {
      if (!state.question || state.question.correct.code !== country.code) return;
      ui.flag.classList.add("is-in");
      if (!state.questionShownAt) state.questionShownAt = performance.now();
    }
    ui.flag.onload = revealFlag;
    ui.flag.onerror = function () {
      if (!state.question || state.question.correct.code !== country.code) return;
      var step = ui.flag.dataset.fallback || "";
      if (step === "") {
        ui.flag.dataset.fallback = "png";
        ui.flag.src = FQGame.flagFallback(country.code, "png");
        return;
      }
      if (step === "png") {
        ui.flag.dataset.fallback = "svg";
        ui.flag.src = FQGame.flagFallback(country.code, "svg");
        return;
      }
      skipBroken(country.code);
    };
    delete ui.flag.dataset.fallback;
    ui.flag.src = FQGame.flagSrc(country.code);
    if (ui.flag.complete && ui.flag.naturalWidth) revealFlag();
    else requestAnimationFrame(function () {
      if (ui.flag.naturalWidth) revealFlag();
    });
    state.revealTimer = setTimeout(function () {
      if (state.question && state.question.correct.code === country.code && !state.questionShownAt) {
        state.questionShownAt = performance.now();
      }
    }, 1400);
    ui.options.replaceChildren();
    state.question.options.forEach(function (option, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "opt";
      var letter = el("span", "letter", "ABCD"[index]);
      var label = el("span", "", option.name);
      button.append(letter, label);
      button.addEventListener("click", function () { choose(option); });
      ui.options.appendChild(button);
    });
    var upcoming = state.queue[state.index + 1];
    if (upcoming) {
      var preload = new Image();
      preload.src = FQGame.flagSrc(upcoming.code);
    }
    renderHud();
    renderProgress();
  }

  function skipBroken(code) {
    if (state.over || !state.question || state.question.correct.code !== code) return;
    state.locked = true;
    clearTimeout(state.auto);
    ui.feedback.hidden = false;
    ui.feedback.className = "feedback";
    ui.feedback.textContent = "Essa bandeira não abriu aqui. A próxima entra no lugar, sem descontar ponto.";
    ui.live.textContent = ui.feedback.textContent;
    state.auto = setTimeout(function () {
      if (state.over) return;
      state.index += 1;
      if (state.index >= state.queue.length) finish();
      else renderQuestion();
    }, 650);
  }

  function choose(option) {
    if (state.locked || state.over || !state.question) return;
    state.locked = true;
    var elapsed = state.questionShownAt ? performance.now() - state.questionShownAt : 8000;
    var hit = option.code === state.question.correct.code;
    var scored = FQGame.scoreAnswer(hit, elapsed, state.streak);
    state.streak = scored.streak;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
    state.times.push(elapsed);
    if (hit) {
      state.correct += 1;
      state.score += scored.points;
      state.speedTotal += scored.speed;
      ui.stage.classList.add("is-right");
      FQAudio.play("ok");
      burst(true);
      floatScore("+" + scored.points);
    } else {
      state.wrong += 1;
      ui.stage.classList.add("is-wrong");
      FQAudio.play("bad");
      burst(false);
    }
    Array.prototype.forEach.call(ui.options.children, function (button) {
      var name = button.querySelector("span:last-child").textContent;
      button.disabled = true;
      if (name === state.question.correct.name) button.classList.add(hit ? "is-correct" : "is-reveal");
      else if (name === option.name) button.classList.add("is-wrong");
    });
    var praise = PRAISE[Math.floor(Math.random() * PRAISE.length)];
    var message = hit
      ? praise + " " + option.name + " · +" + scored.points + " pontos"
      : "A bandeira é de " + state.question.correct.name + ".";
    if (hit && scored.speed) message += " · bônus de velocidade";
    if (hit && state.streak >= 3) message += " · sequência " + state.streak;
    ui.feedback.hidden = false;
    ui.feedback.className = "feedback " + (hit ? "good" : "bad");
    ui.feedback.textContent = message;
    ui.live.textContent = message;
    ui.flag.alt = "Bandeira de " + state.question.correct.name;
    var last = state.index + 1 >= state.queue.length && state.mode !== "timed";
    ui.nextBtn.hidden = false;
    ui.nextBtn.textContent = last ? "Ver resultado" : "Próxima bandeira";
    renderHud();
    renderProgress();
    if (state.mode === "world" || state.mode === "infinite") persistResume();
    if (state.mode === "timed") state.auto = setTimeout(advance, 720);
  }

  function advance() {
    if (state.over || !state.locked) return;
    clearTimeout(state.auto);
    state.index += 1;
    if (state.index >= state.queue.length) {
      finish();
      return;
    }
    if (state.mode === "timed" && state.remainingMs <= 0) {
      finish();
      return;
    }
    renderQuestion();
    if (state.mode === "world" || state.mode === "infinite") persistResume();
  }

  function finish() {
    if (state.over) return;
    state.over = true;
    cleanupTimers();
    var answered = state.correct + state.wrong;
    var modeStats = store.stats.modes[state.mode] || { best: 0, plays: 0 };
    var previousBest = modeStats.best || 0;
    var isRecord = answered > 0 && state.score > previousBest;
    store.resume = null;
    if (answered > 0 && state.mode) {
      store.stats.played += 1;
      store.stats.correct += state.correct;
      store.stats.answered += answered;
      store.stats.bestStreak = Math.max(store.stats.bestStreak, state.bestStreak);
      modeStats.plays += 1;
      modeStats.best = Math.max(previousBest, state.score);
      store.stats.modes[state.mode] = modeStats;
      store.scores.unshift({
        name: store.name || "Explorador",
        mode: state.mode,
        score: state.score,
        accuracy: Math.round((state.correct / answered) * 100),
        correct: state.correct,
        total: answered,
        streak: state.bestStreak,
        date: Date.now()
      });
      store.scores = store.scores.slice(0, 40);
    }
    FQStore.save(store);
    if (window.VexoraAccount && answered > 0) {
      VexoraAccount.saveMatch({
        mode: state.mode,
        score: state.score,
        correct: state.correct,
        total: answered,
        streak: state.bestStreak
      }, function (person) {
        if (!person) return;
        VexoraAccount.applyStats(store, person);
        FQStore.save(store);
        renderHome();
      });
    }
    renderResults(isRecord, answered);
    show("results");
  }

  function avgTime() {
    if (!state.times.length) return "—";
    var sum = state.times.reduce(function (total, time) { return total + time; }, 0);
    return (sum / state.times.length / 1000).toFixed(1).replace(".", ",") + " s";
  }

  function stars(percent) {
    var count = percent >= 90 ? 3 : percent >= 70 ? 2 : percent >= 40 ? 1 : 0;
    return "★★★".slice(0, count) + "☆☆☆".slice(0, 3 - count);
  }

  function headline(percent, answered) {
    if (!answered) return "A mesa ainda está em branco";
    if (percent === 100) return "Atlas perfeito";
    if (percent >= 90) return "Olhar de explorador";
    if (percent >= 75) return "Boa travessia";
    if (percent >= 50) return "Rota em progresso";
    return "O mapa ainda tem mistérios";
  }

  function renderResults(isRecord, answered) {
    var percent = answered ? Math.round((state.correct / answered) * 100) : 0;
    var mount = ui.resultsMount;
    mount.replaceChildren();
    var head = el("div", "result-head");
    var copy = el("div");
    copy.appendChild(el("p", "kicker", MODE[state.mode] || "Partida"));
    copy.appendChild(el("h1", "", headline(percent, answered)));
    copy.appendChild(el("p", "stars", stars(percent)));
    copy.appendChild(el("p", "lead", answered
      ? "Você reconheceu " + state.correct + " de " + answered + " bandeiras."
      : "Nenhuma bandeira foi respondida nesta partida."));
    if (isRecord) copy.appendChild(el("p", "record-stamp", "Novo recorde"));
    var ring = el("div", "ring");
    ring.style.setProperty("--p", String(percent));
    var hole = el("div", "ring-hole");
    hole.appendChild(el("b", "", percent + "%"));
    hole.appendChild(el("span", "", "acertos"));
    ring.appendChild(hole);
    head.append(copy, ring);
    var grid = el("div", "result-grid");
    [
      ["Pontos", pts(state.score)],
      ["Acertos", state.correct],
      ["Erros", state.wrong],
      ["Sequência máxima", state.bestStreak],
      ["Tempo médio", avgTime()],
      ["Bônus de velocidade", pts(state.speedTotal)]
    ].forEach(function (pair) {
      grid.appendChild(statTile(pair[0], pair[1]));
    });
    var actions = el("div", "quiz-actions");
    var again = el("button", "btn primary", "Jogar de novo");
    again.type = "button";
    again.addEventListener("click", function () { startGame(state.mode, false); });
    var modes = el("button", "btn ghost", "Outros modos");
    modes.type = "button";
    modes.addEventListener("click", function () { show("modes"); });
    var ranking = el("button", "btn ghost", "Ver ranking");
    ranking.type = "button";
    ranking.addEventListener("click", function () { show("ranking"); });
    actions.append(again, modes, ranking);
    mount.append(head, grid, actions);
  }

  function matchesMode(item) {
    return rankFilter === "all" || item.mode === rankFilter;
  }

  function rankRow(item, index, demo) {
    var row = el("article", "rank-item" + (demo ? " is-demo" : ""));
    row.appendChild(el("span", "place" + (!demo && index < 3 ? " medal" : ""), String(index + 1)));
    var mid = el("div", "rank-copy");
    mid.appendChild(el("strong", "", item.name));
    var detail = (MODE[item.mode] || item.mode) + " · " + item.accuracy + "% de acertos";
    if (!demo && item.date) detail += " · " + new Date(item.date).toLocaleDateString("pt-BR");
    mid.appendChild(el("span", "", detail));
    if (demo) mid.appendChild(el("em", "badge", "Demonstração"));
    row.appendChild(mid);
    row.appendChild(el("b", "", pts(item.score)));
    return row;
  }

  function renderRanking() {
    var person = window.VexoraAccount && VexoraAccount.user;
    ui.rankWho.textContent = "Os pontos entram como " + ((person && (person.displayName || person.username)) || store.name || "sua conta") + ".";
    var rows = ((window.VexoraAccount && VexoraAccount.ranking) || []).filter(matchesMode).slice().sort(function (a, b) {
      return b.score - a.score;
    });
    ui.rankMount.replaceChildren();
    var board = el("section", "rank-block");
    board.appendChild(el("h2", "", "Jogadores"));
    if (!rows.length) {
      board.appendChild(el("p", "empty", "O placar mostra só contas reais, depois que alguém termina uma partida."));
    } else {
      rows.forEach(function (item, index) { board.appendChild(rankRow(item, index, false)); });
    }
    ui.rankMount.appendChild(board);
  }

  function ensureLearn() {
    if (learnBuilt) return;
    var ordered = countries.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, "pt-BR");
    });
    ordered.forEach(function (country) {
      var card = document.createElement("button");
      card.type = "button";
      card.className = "flag-card";
      card.dataset.region = country.region;
      card.dataset.blob = (country.name + " " + country.capital).toLocaleLowerCase("pt-BR");
      var image = document.createElement("img");
      image.alt = "Bandeira de " + country.name;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", function () {
        var step = image.dataset.fallback || "";
        if (step === "svg") return;
        image.dataset.fallback = step === "png" ? "svg" : "png";
        image.src = FQGame.flagFallback(country.code, image.dataset.fallback);
      });
      image.src = FQGame.flagSrc(country.code);
      var meta = el("div", "meta");
      meta.appendChild(el("strong", "", country.name));
      meta.appendChild(el("small", "", country.capital + " · " + country.region));
      card.append(image, meta);
      card.addEventListener("click", function () {
        if (ui.learnGrid.classList.contains("is-blind")) card.classList.toggle("is-open");
      });
      ui.learnGrid.appendChild(card);
    });
    learnBuilt = true;
  }

  function applyLearnFilter() {
    var query = ui.learnSearch.value.trim().toLocaleLowerCase("pt-BR");
    var region = "Todas";
    var active = ui.learnChips.querySelector(".chip.is-on");
    if (active) region = active.dataset.region;
    var visible = 0;
    Array.prototype.forEach.call(ui.learnGrid.children, function (card) {
      var okRegion = region === "Todas" || card.dataset.region === region;
      var okText = !query || card.dataset.blob.indexOf(query) !== -1;
      card.hidden = !(okRegion && okText);
      if (!card.hidden) visible += 1;
    });
    ui.learnEmpty.hidden = visible !== 0;
  }

  function burst(good) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var colors = good ? ["#ff8a3d", "#0c8f86", "#ffd166", "#3c4ed0"] : ["#e23d22", "#ffd0c8"];
    for (var i = 0; i < (good ? 12 : 6); i++) {
      var bit = document.createElement("i");
      bit.className = "bit";
      bit.style.left = (6 + Math.random() * 88) + "%";
      bit.style.top = "10px";
      bit.style.background = colors[i % colors.length];
      bit.style.setProperty("--x", (Math.random() * 36 - 18) + "px");
      bit.style.setProperty("--y", (18 + Math.random() * 36) + "px");
      ui.stage.appendChild(bit);
      bit.addEventListener("animationend", function () { this.remove(); });
    }
  }

  function floatScore(text) {
    var node = el("div", "floater", text);
    ui.stage.appendChild(node);
    setTimeout(function () { node.remove(); }, 900);
  }

  function syncSound() {
    ui.soundToggle.setAttribute("aria-pressed", store.sound ? "true" : "false");
    ui.soundToggle.textContent = store.sound ? "Som ligado" : "Som mudo";
  }

  function bind() {
    document.body.addEventListener("click", function (event) {
      var destination = event.target.closest("[data-go]");
      if (destination) {
        if (state.view === "quiz" && !state.over) leaveQuiz();
        show(destination.dataset.go);
        return;
      }
      var modeButton = event.target.closest("[data-mode]");
      if (modeButton && modeButton.dataset.mode) startGame(modeButton.dataset.mode, false);
    });
    ui.nextBtn.addEventListener("click", advance);
    ui.stopBtn.addEventListener("click", finish);
    ui.soundToggle.addEventListener("click", function () {
      store.sound = !store.sound;
      FQStore.save(store);
      syncSound();
      if (store.sound) {
        FQAudio.unlock();
        FQAudio.play("tap");
      }
    });
    ui.playerName.addEventListener("input", function () {
      store.name = ui.playerName.value.trim().slice(0, 18);
      FQStore.save(store);
    });
    ui.wipeBtn.addEventListener("click", function () {
      if (!window.confirm("Isso limpa só o cache deste navegador. A conta e os recordes do servidor continuam.")) return;
      var sound = store.sound;
      store = FQStore.empty();
      store.sound = sound;
      if (window.VexoraAccount && VexoraAccount.user) VexoraAccount.applyStats(store, VexoraAccount.user);
      FQStore.save(store);
      ui.playerName.value = store.name || "";
      renderRanking();
      renderHome();
    });
    ui.rankChips.addEventListener("click", function (event) {
      var chip = event.target.closest(".chip");
      if (!chip) return;
      rankFilter = chip.dataset.mode;
      Array.prototype.forEach.call(ui.rankChips.children, function (item) {
        item.classList.toggle("is-on", item === chip);
      });
      if (window.VexoraAccount) VexoraAccount.loadRanking(rankFilter).then(renderRanking);
      else renderRanking();
    });
    ui.learnChips.addEventListener("click", function (event) {
      var chip = event.target.closest(".chip");
      if (!chip) return;
      Array.prototype.forEach.call(ui.learnChips.children, function (item) {
        item.classList.toggle("is-on", item === chip);
      });
      applyLearnFilter();
    });
    ui.learnSearch.addEventListener("input", applyLearnFilter);
    ui.blindToggle.addEventListener("click", function () {
      var on = ui.learnGrid.classList.toggle("is-blind");
      ui.blindToggle.setAttribute("aria-pressed", on ? "true" : "false");
      ui.blindToggle.textContent = on ? "Mostrar nomes" : "Ocultar nomes";
    });
    document.addEventListener("keydown", function (event) {
      if (state.view !== "quiz") return;
      if (event.target.matches("input, textarea")) return;
      if (!state.locked && ["1", "2", "3", "4"].indexOf(event.key) !== -1) {
        var button = ui.options.children[Number(event.key) - 1];
        if (button) button.click();
      }
      if (event.key === "Enter" && state.locked) {
        event.preventDefault();
        advance();
      }
    });
  }

  grab();
  loadCountries();
  bind();
  ui.playerName.value = store.name || "";
  syncSound();
  ui.atlasNote.textContent = "O atlas tem " + countries.length + " bandeiras de países e territórios, guardadas junto com o jogo. Se uma imagem falhar, o site tenta de novo e segue sem descontar ponto.";
    document.querySelectorAll(".hero-art img").forEach(function (img) {
      img.addEventListener("error", function () {
        if (img.dataset.fallback === "1") return;
        var match = (img.getAttribute("src") || "").match(/([a-z]{2})\.png/);
        if (!match) return;
        img.dataset.fallback = "1";
        img.src = FQGame.flagFallback(match[1], "png");
      });
    });
  if (countries.length < 4) {
    ui.bootError.hidden = false;
    ui.bootError.textContent = "O atlas não carregou bandeiras suficientes para começar.";
  }
  function applyAccount(person) {
    if (!person || !window.VexoraAccount) return;
    VexoraAccount.applyStats(store, person);
    FQStore.save(store);
    ui.playerName.value = store.name || "";
    if (state.view === "home") renderHome();
  }
  window.FQ = {
    countries: countries,
    test: function () { return FQGame.selfTest(countries); },
    applyAccount: applyAccount,
    renderRanking: renderRanking,
    rankFilter: function () { return rankFilter; }
  };
  VexoraAccount.start(function () { show("home"); });
})();
