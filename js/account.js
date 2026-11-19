(function () {
  var ACHIEVEMENTS = {
    primeira_partida: "Primeira partida",
    sequencia_5: "Sequência de 5",
    sequencia_10: "Sequência de 10",
    recorde_1000: "Recorde de 1.000 pontos",
    classico_perfeito: "Clássico sem erros",
    dez_partidas: "Dez partidas",
    primeiro_amigo: "Primeiro amigo"
  };
  var AVATARS = ["compass", "globe", "ship", "sun", "palm", "mountain", "star", "flag"];
  var MODE = { classic: "Clássico", infinite: "Infinito", timed: "Contra o tempo", world: "Desafio mundial" };
  var user = null;
  var ranking = [];
  var screen = "login";
  var timer = 0;

  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Vexora": "1" },
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        data.ok = response.ok;
        return data;
      });
    }).catch(function () {
      return { ok: false, error: "Sem conexão com o Vexora. Abra o jogo pelo servidor local." };
    });
  }

  function avatarSvg(id) {
    var shapes = {
      compass: '<path d="M32 8l8 20-8 5-8-5z" fill="#ffb703"/><path d="M32 56l-8-20 8-5 8 5z" fill="#fff"/><circle cx="32" cy="32" r="4" fill="#e23d22"/>',
      globe: '<circle cx="32" cy="32" r="16" fill="none" stroke="#fff" stroke-width="3"/><ellipse cx="32" cy="32" rx="7" ry="16" fill="none" stroke="#ffb703" stroke-width="3"/><path d="M16 32h32M20 22h24M20 42h24" stroke="#fff" stroke-width="2"/>',
      ship: '<path d="M18 40l14-22 14 22z" fill="#fff"/><path d="M14 44h36" stroke="#ffb703" stroke-width="4"/><path d="M32 18V10" stroke="#e23d22" stroke-width="3"/>',
      sun: '<circle cx="32" cy="32" r="10" fill="#ffb703"/><path d="M32 12v6M32 46v6M12 32h6M46 32h6M18 18l4 4M42 42l4 4M46 18l-4 4M22 42l-4 4" stroke="#fff" stroke-width="3"/>',
      palm: '<path d="M32 50V28" stroke="#fff" stroke-width="3"/><path d="M32 28c-10-2-16-12-14-16 8 2 14 10 14 16zM32 28c10-2 16-12 14-16-8 2-14 10-14 16z" fill="#0c8f86"/>',
      mountain: '<path d="M10 48l16-26 8 12 6-8 14 22z" fill="#fff"/><path d="M26 22l6 10" stroke="#ffb703" stroke-width="3"/>',
      star: '<path d="M32 12l5 12 13 1-10 8 3 13-11-7-11 7 3-13-10-8 13-1z" fill="#ffb703"/>',
      flag: '<path d="M20 14v36" stroke="#fff" stroke-width="3"/><path d="M22 16h22l-6 8 6 8H22z" fill="#e23d22"/>'
    };
    return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="#1b2830"></circle>' + (shapes[id] || shapes.compass) + "</svg>";
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function list(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function pts(value) {
    return String(value || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function dateLabel(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return "";
    return date.toLocaleDateString("pt-BR");
  }

  function recordOf(person) {
    var best = 0;
    var mode = "";
    if (!person || !person.best) return { score: 0, mode: "" };
    Object.keys(person.best).forEach(function (key) {
      if (person.best[key] && person.best[key].score > best) {
        best = person.best[key].score;
        mode = key;
      }
    });
    return { score: best, mode: mode };
  }

  function toast(text) {
    var node = document.getElementById("toast");
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { node.hidden = true; }, 4200);
  }

  function message(text, kind) {
    var node = document.getElementById("authMsg");
    node.hidden = !text;
    node.textContent = text || "";
    node.className = "form-msg" + (kind ? " is-" + kind : "");
  }

  function field(label, type, name, extra) {
    var wrap = el("label", "field");
    wrap.appendChild(el("span", "", label));
    var input = document.createElement("input");
    input.type = type;
    input.name = name;
    input.required = true;
    input.autocomplete = extra || "off";
    wrap.appendChild(input);
    return wrap;
  }

  function paintAuth() {
    var form = document.getElementById("authForm");
    var fields = document.getElementById("authFields");
    var submit = document.getElementById("authSubmit");
    var switcher = document.getElementById("authSwitch");
    var params = new URLSearchParams(location.search);
    if (params.get("reset") && screen === "login") screen = "reset";
    fields.replaceChildren();
    switcher.replaceChildren();
    message("");
    document.getElementById("authKicker").textContent = screen === "login" ? "Sua conta" : screen === "register" ? "Novo jogador" : "Recuperação";
    document.getElementById("authTitle").textContent = screen === "login" ? "Entrar no Vexora" : screen === "register" ? "Criar uma conta" : screen === "forgot" ? "Esqueci a senha" : "Nova senha";
    document.getElementById("authLead").textContent = screen === "login"
      ? "A pontuação, o nível e os amigos ficam ligados à sua conta."
      : screen === "register"
        ? "Escolha um nome, um e-mail e uma senha. A senha não fica visível no aparelho."
        : screen === "forgot"
          ? "Informe o e-mail da conta. A troca de senha vale por 30 minutos neste computador."
          : "Escolha uma senha nova para esta conta.";

    if (screen === "login") {
      fields.appendChild(field("E-mail", "email", "email", "username"));
      fields.appendChild(field("Senha", "password", "password", "current-password"));
      var keep = el("label", "check");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.name = "remember";
      keep.appendChild(box);
      keep.appendChild(document.createTextNode(" Manter conectado neste aparelho"));
      fields.appendChild(keep);
      submit.textContent = "Entrar";
      var forgot = el("button", "text-btn", "Esqueci a senha");
      forgot.type = "button";
      forgot.addEventListener("click", function () { screen = "forgot"; paintAuth(); });
      var create = el("button", "text-btn", "Criar conta");
      create.type = "button";
      create.addEventListener("click", function () { screen = "register"; paintAuth(); });
      switcher.append(forgot, create);
    }
    if (screen === "register") {
      fields.appendChild(field("Nome de usuário", "text", "username", "username"));
      fields.appendChild(field("E-mail", "email", "email", "email"));
      fields.appendChild(field("Senha", "password", "password", "new-password"));
      fields.appendChild(field("Confirmar senha", "password", "confirm", "new-password"));
      submit.textContent = "Cadastrar";
      var back = el("button", "text-btn", "Já tenho conta");
      back.type = "button";
      back.addEventListener("click", function () { screen = "login"; paintAuth(); });
      switcher.appendChild(back);
    }
    if (screen === "forgot") {
      fields.appendChild(field("E-mail", "email", "email", "username"));
      submit.textContent = "Pedir recuperação";
      var backLogin = el("button", "text-btn", "Voltar ao login");
      backLogin.type = "button";
      backLogin.addEventListener("click", function () { screen = "login"; paintAuth(); });
      switcher.appendChild(backLogin);
    }
    if (screen === "reset") {
      fields.appendChild(field("Nova senha", "password", "password", "new-password"));
      fields.appendChild(field("Confirmar senha", "password", "confirm", "new-password"));
      submit.textContent = "Salvar senha";
    }
    form.hidden = false;
  }

  function unlock(next) {
    user = next;
    document.body.classList.remove("is-locked");
    document.getElementById("gate").hidden = true;
    document.getElementById("logoutBtn").hidden = false;
    document.getElementById("notifyBtn").hidden = false;
    if (window.FQ && window.FQ.applyAccount) window.FQ.applyAccount(next);
    refreshNotifications();
    clearInterval(timer);
    timer = setInterval(refreshNotifications, 20000);
  }

  function readForm(form) {
    var data = {};
    Array.prototype.forEach.call(form.elements, function (input) {
      if (!input.name) return;
      data[input.name] = input.type === "checkbox" ? input.checked : input.value;
    });
    return data;
  }

  function validate(data) {
    if (screen === "register" && !/^[A-Za-z0-9_.]{3,18}$/.test((data.username || "").trim())) {
      return "O nome de usuário precisa ter de 3 a 18 letras, números, ponto ou _.";
    }
    if (screen !== "reset" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((data.email || "").trim())) {
      return "Digite um e-mail válido.";
    }
    if (screen !== "forgot" && ((data.password || "").length < 8 || (data.password || "").length > 72)) {
      return "A senha precisa ter entre 8 e 72 caracteres.";
    }
    if ((screen === "register" || screen === "reset") && data.password !== data.confirm) {
      return "A confirmação da senha não confere.";
    }
    return "";
  }

  function onAuth(event) {
    event.preventDefault();
    var data = readForm(event.target);
    var problem = validate(data);
    if (problem) { message(problem, "error"); return; }
    var submit = document.getElementById("authSubmit");
    submit.disabled = true;
    var done = function (result) {
      submit.disabled = false;
      if (!result.ok) { message(result.error || "Não foi possível concluir.", "error"); return; }
      if (screen === "forgot") { message(result.message, "ok"); return; }
      if (result.user) {
        history.replaceState(null, "", location.pathname);
        unlock(result.user);
      }
    };
    if (screen === "login") {
      api("/api/login", { method: "POST", body: { email: data.email.trim(), password: data.password, remember: !!data.remember } }).then(done);
    } else if (screen === "register") {
      api("/api/register", { method: "POST", body: { username: data.username.trim(), email: data.email.trim(), password: data.password, confirm: data.confirm } }).then(done);
    } else if (screen === "forgot") {
      api("/api/forgot", { method: "POST", body: { email: data.email.trim() } }).then(done);
    } else {
      api("/api/reset", { method: "POST", body: { token: new URLSearchParams(location.search).get("reset") || "", password: data.password, confirm: data.confirm } }).then(done);
    }
  }

  function achievementList(ids) {
    var items = el("ul", "badges");
    var owned = list(ids);
    if (!owned.length) {
      items.appendChild(el("li", "badge is-empty", "Nenhuma conquista ainda"));
      return items;
    }
    owned.forEach(function (id) {
      items.appendChild(el("li", "badge", ACHIEVEMENTS[id] || id));
    });
    return items;
  }

  function profileCard(person, mine) {
    var card = el("article", "profile-card");
    var head = el("div", "profile-head");
    var face = el("div", "avatar");
    face.innerHTML = avatarSvg(person.avatar || "compass");
    var copy = el("div", "");
    copy.appendChild(el("h2", "", person.displayName || person.username));
    copy.appendChild(el("p", "who", "@" + person.username + " · nível " + person.level));
    if (person.bio) copy.appendChild(el("p", "", person.bio));
    copy.appendChild(el("p", "who", "Conta criada em " + dateLabel(person.createdAt)));
    head.append(face, copy);
    var grid = el("div", "result-grid");
    [
      ["Nível", person.level],
      ["XP", pts(person.xp)],
      ["Partidas", person.played],
      ["Acertos", person.accuracy + "%"],
      ["Melhor sequência", person.bestStreak],
      ["Recorde", pts(recordOf(person).score)]
    ].forEach(function (pair) {
      var tile = el("div", "tile");
      tile.appendChild(el("span", "", pair[0]));
      tile.appendChild(el("strong", "", String(pair[1])));
      grid.appendChild(tile);
    });
    card.append(head, grid, achievementList(person.achievements));
    if (mine) card.appendChild(editForm(person));
    return card;
  }

  function editForm(person) {
    var form = el("form", "edit-card");
    form.appendChild(el("h3", "", "Editar perfil"));
    var name = field("Nome de exibição", "text", "displayName", "nickname");
    name.querySelector("input").value = person.displayName || "";
    name.querySelector("input").required = true;
    var bio = el("label", "field");
    bio.appendChild(el("span", "", "Descrição"));
    var area = document.createElement("textarea");
    area.name = "bio";
    area.maxLength = 140;
    area.value = person.bio || "";
    bio.appendChild(area);
    var picker = el("div", "avatar-picker");
    AVATARS.forEach(function (id) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "avatar-choice" + (id === person.avatar ? " is-on" : "");
      button.innerHTML = avatarSvg(id);
      button.addEventListener("click", function () {
        person.avatar = id;
        Array.prototype.forEach.call(picker.children, function (item) { item.classList.remove("is-on"); });
        button.classList.add("is-on");
      });
      picker.appendChild(button);
    });
    var note = el("p", "form-msg");
    note.hidden = true;
    var save = el("button", "btn primary", "Salvar perfil");
    save.type = "submit";
    form.append(name, bio, picker, note, save);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var displayName = form.elements.displayName.value.trim();
      var about = form.elements.bio.value.trim();
      if (displayName.length < 2 || displayName.length > 24) {
        note.hidden = false;
        note.className = "form-msg is-error";
        note.textContent = "O nome de exibição precisa ter de 2 a 24 caracteres.";
        return;
      }
      save.disabled = true;
      api("/api/me", { method: "PATCH", body: { displayName: displayName, bio: about, avatar: person.avatar || "compass" } }).then(function (result) {
        save.disabled = false;
        note.hidden = false;
        if (!result.ok) {
          note.className = "form-msg is-error";
          note.textContent = result.error || "Não foi possível salvar.";
          return;
        }
        user = result.user;
        note.className = "form-msg is-ok";
        note.textContent = "Perfil atualizado.";
        if (window.FQ && window.FQ.applyAccount) window.FQ.applyAccount(user);
        renderProfile();
      });
    });
    return form;
  }

  function renderProfile() {
    var mount = document.getElementById("profileMount");
    if (!mount || !user) return;
    api("/api/history").then(function (result) {
      mount.replaceChildren(profileCard(user, true));
      var history = el("section", "rank-block");
      history.appendChild(el("h2", "", "Partidas recentes"));
      var rows = list(result.history);
      if (!rows.length) history.appendChild(el("p", "empty", "Suas partidas aparecem aqui depois da primeira rodada."));
      rows.forEach(function (item) {
        var row = el("article", "rank-item");
        var mid = el("div", "rank-copy");
        mid.appendChild(el("strong", "", MODE[item.mode] || item.mode));
        mid.appendChild(el("span", "", item.correct + "/" + item.total + " · sequência " + item.streak + " · " + dateLabel(item.date)));
        row.appendChild(mid);
        row.appendChild(el("b", "", pts(item.score)));
        history.appendChild(row);
      });
      mount.appendChild(history);
    });
  }

  function personRow(person, actions) {
    var row = el("article", "friend-card");
    var face = el("div", "avatar sm");
    face.innerHTML = avatarSvg(person.avatar || "compass");
    var copy = el("div", "rank-copy");
    var title = el("button", "text-btn name", person.displayName || person.username);
    title.type = "button";
    title.addEventListener("click", function () { openProfile(person.id); });
    copy.appendChild(title);
    copy.appendChild(el("span", "", "@" + person.username + " · nível " + person.level));
    row.append(face, copy);
    actions.forEach(function (action) { row.appendChild(action); });
    return row;
  }

  function openProfile(id) {
    api("/api/users/" + id).then(function (result) {
      var mount = document.getElementById("friendsMount");
      if (!result.ok) { toast(result.error || "Perfil indisponível."); return; }
      var view = el("div", "");
      var back = el("button", "btn ghost", "Voltar aos amigos");
      back.type = "button";
      back.addEventListener("click", renderFriends);
      view.appendChild(back);
      view.appendChild(profileCard(result.user, false));
      var mine = recordOf(user);
      var theirs = recordOf(result.user);
      var compare = el("p", "compare");
      if (!mine.score && !theirs.score) compare.textContent = "Nenhum dos dois tem recorde ainda.";
      else if (mine.score === theirs.score) compare.textContent = "Os recordes estão empatados em " + pts(mine.score) + ".";
      else if (mine.score > theirs.score) compare.textContent = "Seu recorde é maior: " + pts(mine.score) + " contra " + pts(theirs.score) + ".";
      else compare.textContent = (result.user.displayName || result.user.username) + " está na frente: " + pts(theirs.score) + " contra " + pts(mine.score) + ".";
      view.appendChild(compare);
      mount.replaceChildren(view);
    });
  }

  function renderFriends() {
    var mount = document.getElementById("friendsMount");
    if (!mount) return;
    api("/api/friends").then(function (pack) {
      mount.replaceChildren();
      var search = el("form", "search-row");
      var input = document.createElement("input");
      input.type = "search";
      input.placeholder = "Pesquisar pelo nome";
      input.setAttribute("aria-label", "Pesquisar jogadores");
      var button = el("button", "btn primary", "Buscar");
      button.type = "submit";
      var results = el("div", "stack");
      search.append(input, button);
      search.addEventListener("submit", function (event) {
        event.preventDefault();
        var query = input.value.trim();
        if (query.length < 2) { toast("Digite pelo menos 2 letras."); return; }
        api("/api/users/search?q=" + encodeURIComponent(query)).then(function (found) {
          results.replaceChildren();
          found.users = list(found.users);
          if (!found.users.length) {
            results.appendChild(el("p", "empty", "Nenhum jogador com esse nome."));
            return;
          }
          found.users.forEach(function (person) {
            var add = el("button", "btn ghost", "Adicionar");
            add.type = "button";
            add.addEventListener("click", function () {
              api("/api/friends", { method: "POST", body: { userId: person.id } }).then(function (response) {
                toast(response.ok ? "Solicitação enviada." : (response.error || "Não foi possível enviar."));
                if (response.ok) renderFriends();
              });
            });
            results.appendChild(personRow(person, [add]));
          });
        });
      });
      mount.append(search, results);

      function block(title, rows, empty, maker) {
        var section = el("section", "rank-block");
        section.appendChild(el("h2", "", title));
        if (!rows.length) section.appendChild(el("p", "empty", empty));
        rows.forEach(function (row) { section.appendChild(maker(row)); });
        mount.appendChild(section);
      }

      block("Solicitações recebidas", list(pack.incoming), "Nenhuma solicitação esperando resposta.", function (row) {
        var accept = el("button", "btn primary", "Aceitar");
        var decline = el("button", "btn ghost", "Recusar");
        accept.type = "button";
        decline.type = "button";
        accept.addEventListener("click", function () { respond(row.requestId, "accept"); });
        decline.addEventListener("click", function () { respond(row.requestId, "decline"); });
        return personRow(row.user, [accept, decline]);
      });
      block("Solicitações enviadas", list(pack.outgoing), "Você não enviou pedidos.", function (row) {
        var cancel = el("button", "btn ghost", "Cancelar");
        cancel.type = "button";
        cancel.addEventListener("click", function () { respond(row.requestId, "cancel"); });
        return personRow(row.user, [cancel]);
      });
      block("Amigos", list(pack.friends), "Sua lista começa quando alguém aceita o pedido.", function (row) {
        var friend = row.user;
        var mine = recordOf(user);
        var theirs = recordOf(friend);
        var line = "Nível " + friend.level + " · " + friend.accuracy + "% de acertos · recorde " + pts(theirs.score);
        if (mine.score || theirs.score) {
          line += mine.score > theirs.score ? " · seu recorde é maior" : mine.score < theirs.score ? " · o recorde dele é maior" : " · recordes iguais";
        }
        var card = personRow(friend, []);
        card.querySelector(".rank-copy").appendChild(el("span", "", line));
        var remove = el("button", "btn ghost", "Remover");
        remove.type = "button";
        remove.addEventListener("click", function () {
          if (!window.confirm("Remover " + (friend.displayName || friend.username) + " da lista?")) return;
          api("/api/friends/" + row.requestId, { method: "DELETE" }).then(function () { renderFriends(); });
        });
        card.appendChild(remove);
        return card;
      });
    });
  }

  function respond(id, action) {
    api("/api/friends/" + id, { method: "POST", body: { action: action } }).then(function (result) {
      if (!result.ok) toast(result.error || "Não foi possível atualizar o pedido.");
      renderFriends();
      refreshNotifications();
      api("/api/me").then(function (me) { if (me.user) user = me.user; });
    });
  }

  function refreshNotifications() {
    if (!user) return;
    api("/api/notifications").then(function (result) {
      var notes = list(result.notifications);
      var unread = notes.filter(function (note) { return !note.read; });
      var badge = document.getElementById("notifyCount");
      badge.textContent = unread.length ? String(unread.length) : "";
      badge.hidden = !unread.length;
      var panel = document.getElementById("notifyPanel");
      panel.replaceChildren();
      if (!notes.length) panel.appendChild(el("p", "empty", "Sem avisos."));
      notes.slice().reverse().slice(0, 8).forEach(function (note) {
        panel.appendChild(el("p", note.read ? "" : "is-new", note.text));
      });
    });
  }

  function loadRanking(mode) {
    return api("/api/ranking?mode=" + encodeURIComponent(mode || "all")).then(function (result) {
      ranking = list(result.ranking);
      return ranking;
    });
  }

  document.addEventListener("vexora:view", function (event) {
    if (!user) return;
    if (event.detail === "friends") renderFriends();
    if (event.detail === "profile") renderProfile();
    if (event.detail === "ranking") {
      loadRanking(window.FQ && window.FQ.rankFilter ? window.FQ.rankFilter() : "all").then(function () {
        if (window.FQ && window.FQ.renderRanking) window.FQ.renderRanking();
      });
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("authForm");
    if (form) form.addEventListener("submit", onAuth);
    var logout = document.getElementById("logoutBtn");
    if (logout) logout.addEventListener("click", function () {
      api("/api/logout", { method: "POST", body: {} }).then(function () { location.reload(); });
    });
    var notify = document.getElementById("notifyBtn");
    var panel = document.getElementById("notifyPanel");
    if (notify) notify.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) api("/api/notifications/read", { method: "POST", body: {} }).then(refreshNotifications);
    });
  });

  window.VexoraAccount = {
    user: null,
    get ranking() { return ranking; },
    start: function (ready) {
      document.body.classList.add("is-locked");
      document.getElementById("gate").hidden = false;
      paintAuth();
      if (new URLSearchParams(location.search).get("reset")) return;
      api("/api/me").then(function (result) {
        if (result.user) {
          unlock(result.user);
          if (ready) ready(result.user);
        }
      });
    },
    applyStats: function (store, person) {
      user = person || user;
      this.user = user;
      if (!store || !user) return;
      store.name = user.displayName || user.username;
      store.stats.played = user.played || 0;
      store.stats.correct = user.correct || 0;
      store.stats.answered = user.answered || 0;
      store.stats.bestStreak = user.bestStreak || 0;
      ["classic", "infinite", "timed", "world"].forEach(function (mode) {
        var row = user.best && user.best[mode] ? user.best[mode] : { score: 0 };
        store.stats.modes[mode] = store.stats.modes[mode] || { best: 0, plays: 0 };
        store.stats.modes[mode].best = row.score || 0;
      });
    },
    saveMatch: function (payload, done) {
      api("/api/matches", { method: "POST", body: payload }).then(function (result) {
        if (result.user) {
          user = result.user;
          window.VexoraAccount.user = user;
          toast("+" + (result.xpGain || 0) + " XP salvos na sua conta.");
        } else toast(result.error || "A partida ficou neste aparelho. A conta não recebeu os pontos.");
        if (done) done(result.user || null);
      });
    },
    loadRanking: loadRanking
  };
})();
