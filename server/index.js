"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 8754;
const IS_PROD = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
const AVATARS = ["compass", "globe", "ship", "sun", "palm", "mountain", "star", "flag"];
const MODES = ["classic", "infinite", "timed", "world"];
const COOKIE = "vexora_session";
const hits = new Map();

const localDir = process.env.VEXORA_DATA || path.join(
  process.env.LOCALAPPDATA || path.join(ROOT, "data"),
  process.env.LOCALAPPDATA ? "vexora-data" : ""
);
const dbPath = path.join(localDir, "db.json");
const outboxPath = path.join(localDir, "reset-outbox.txt");

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });
}

function newId() {
  return crypto.randomBytes(16).toString("hex");
}

function newSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64");
}

function hashPassword(password, saltBuf) {
  return crypto.pbkdf2Sync(password, saltBuf, 150000, 32, "sha256").toString("base64");
}

function sameText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function levelOf(xp) {
  return Math.floor(Number(xp || 0) / 400) + 1;
}

function emptyBest() {
  const best = {};
  MODES.forEach(function (mode) {
    best[mode] = { score: 0, accuracy: 0, date: "" };
  });
  return best;
}

function ensureBest(value) {
  const best = emptyBest();
  const raw = value && typeof value === "object" ? value : {};
  MODES.forEach(function (mode) {
    const row = raw[mode] || {};
    best[mode] = {
      score: Number(row.score) || 0,
      accuracy: Number(row.accuracy) || 0,
      date: row.date ? String(row.date) : ""
    };
  });
  return best;
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function publicUser(user, self) {
  const answered = Number(user.answered) || 0;
  const correct = Number(user.correct) || 0;
  const profile = {
    id: String(user.id),
    username: String(user.username),
    displayName: String(user.display_name || user.displayName || user.username),
    bio: String(user.bio || ""),
    avatar: String(user.avatar || "compass"),
    createdAt: String(user.created_at || user.createdAt || ""),
    level: levelOf(user.xp),
    xp: Number(user.xp) || 0,
    played: Number(user.played) || 0,
    correct: correct,
    answered: answered,
    accuracy: answered > 0 ? Math.round((100 * correct) / answered) : 0,
    bestStreak: Number(user.best_streak != null ? user.best_streak : user.bestStreak) || 0,
    best: ensureBest(user.best),
    achievements: asList(user.achievements)
  };
  if (self) profile.email = String(user.email || "");
  return profile;
}

function allow(ip) {
  const now = Date.now();
  const window = (hits.get(ip) || []).filter(function (stamp) { return stamp > now - 10 * 60 * 1000; });
  if (window.length >= 30) return false;
  window.push(now);
  hits.set(ip, window);
  return true;
}

function readJsonDb() {
  if (!fs.existsSync(dbPath)) {
    return { users: [], sessions: [], resets: [], requests: [], notes: [] };
  }
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeJsonDb(db) {
  fs.mkdirSync(localDir, { recursive: true });
  const temp = dbPath + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(db));
  fs.renameSync(temp, dbPath);
}

async function initPostgres() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT 'compass',
      created_at TIMESTAMPTZ NOT NULL,
      xp INT NOT NULL DEFAULT 0,
      played INT NOT NULL DEFAULT 0,
      correct INT NOT NULL DEFAULT 0,
      answered INT NOT NULL DEFAULT 0,
      best_streak INT NOT NULL DEFAULT 0,
      best JSONB NOT NULL DEFAULT '{}'::jsonb,
      achievements JSONB NOT NULL DEFAULT '[]'::jsonb,
      history JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      from_id TEXT,
      text TEXT NOT NULL,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
}

function setSessionCookie(res, token, days) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    maxAge: days * 86400 * 1000,
    path: "/"
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/" });
}

async function createSession(res, userId, remember) {
  const token = newSecret();
  const days = remember ? 30 : 1;
  const expires = new Date(Date.now() + days * 86400 * 1000).toISOString();
  if (pool) {
    await pool.query(
      "INSERT INTO sessions(token_hash, user_id, expires) VALUES ($1,$2,$3)",
      [hashToken(token), userId, expires]
    );
  } else {
    const db = readJsonDb();
    db.sessions = asList(db.sessions);
    db.sessions.push({ tokenHash: hashToken(token), userId: userId, expires: expires });
    writeJsonDb(db);
  }
  setSessionCookie(res, token, days);
}

async function destroySession(req, res) {
  const token = req.cookies[COOKIE];
  if (token) {
    const hash = hashToken(token);
    if (pool) {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hash]);
    } else {
      const db = readJsonDb();
      db.sessions = asList(db.sessions).filter(function (row) { return row.tokenHash !== hash; });
      writeJsonDb(db);
    }
  }
  clearSessionCookie(res);
}

async function currentUser(req) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const hash = hashToken(token);
  const now = new Date();
  if (pool) {
    const result = await pool.query(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires > $2`,
      [hash, now.toISOString()]
    );
    return result.rows[0] || null;
  }
  const db = readJsonDb();
  const session = asList(db.sessions).find(function (row) {
    return row.tokenHash === hash && new Date(row.expires) > now;
  });
  if (!session) return null;
  return asList(db.users).find(function (user) { return user.id === session.userId; }) || null;
}

function addAchievement(list, id) {
  const owned = asList(list);
  if (owned.indexOf(id) === -1) owned.push(id);
  return owned;
}

async function addNote(userId, kind, fromId, text) {
  const note = {
    id: newId(),
    userId: userId,
    kind: kind,
    fromId: fromId,
    text: text,
    read: false,
    createdAt: new Date().toISOString()
  };
  if (pool) {
    await pool.query(
      "INSERT INTO notes(id, user_id, kind, from_id, text, read, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [note.id, note.userId, note.kind, note.fromId, note.text, false, note.createdAt]
    );
  } else {
    const db = readJsonDb();
    db.notes = asList(db.notes);
    db.notes.push(note);
    writeJsonDb(db);
  }
}

function sendError(res, code, error) {
  return res.status(code).json({ error: error });
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());

app.use(function (req, res, next) {
  if (req.path.startsWith("/api/") && req.method !== "GET" && req.get("X-Vexora") !== "1") {
    return sendError(res, 403, "Pedido recusado.");
  }
  if (["POST", "PATCH", "DELETE"].indexOf(req.method) !== -1 && !allow(req.ip || "unknown")) {
    return sendError(res, 429, "Muitas tentativas. Espere alguns minutos.");
  }
  next();
});

app.get("/api/health", function (_req, res) {
  res.json({ ok: true, storage: pool ? "postgres" : "file" });
});

app.post("/api/register", async function (req, res) {
  try {
    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const confirm = String(req.body.confirm || "");
    if (!/^[A-Za-z0-9_.]{3,18}$/.test(username)) {
      return sendError(res, 400, "O nome de usuário precisa ter de 3 a 18 letras, números, ponto ou _.");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendError(res, 400, "Digite um e-mail válido.");
    if (password.length < 8 || password.length > 72) {
      return sendError(res, 400, "A senha precisa ter entre 8 e 72 caracteres.");
    }
    if (password !== confirm) return sendError(res, 400, "A confirmação da senha não confere.");
    const salt = crypto.randomBytes(16);
    const user = {
      id: newId(),
      username: username,
      displayName: username,
      email: email,
      passwordHash: hashPassword(password, salt),
      passwordSalt: salt.toString("base64"),
      bio: "",
      avatar: "compass",
      createdAt: new Date().toISOString(),
      xp: 0,
      played: 0,
      correct: 0,
      answered: 0,
      bestStreak: 0,
      best: emptyBest(),
      achievements: [],
      history: []
    };
    if (pool) {
      const clash = await pool.query(
        "SELECT username, email FROM users WHERE lower(username) = lower($1) OR email = $2 LIMIT 1",
        [username, email]
      );
      if (clash.rows[0]) {
        if (String(clash.rows[0].username).toLowerCase() === username.toLowerCase()) {
          return sendError(res, 409, "Esse nome de usuário já está em uso.");
        }
        return sendError(res, 409, "Esse e-mail já está cadastrado.");
      }
      await pool.query(
        `INSERT INTO users(id, username, display_name, email, password_hash, password_salt, bio, avatar, created_at, xp, played, correct, answered, best_streak, best, achievements, history)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb)`,
        [
          user.id, user.username, user.displayName, user.email, user.passwordHash, user.passwordSalt,
          user.bio, user.avatar, user.createdAt, 0, 0, 0, 0, 0,
          JSON.stringify(user.best), JSON.stringify([]), JSON.stringify([])
        ]
      );
    } else {
      const db = readJsonDb();
      db.users = asList(db.users);
      if (db.users.some(function (row) { return String(row.username).toLowerCase() === username.toLowerCase(); })) {
        return sendError(res, 409, "Esse nome de usuário já está em uso.");
      }
      if (db.users.some(function (row) { return String(row.email).toLowerCase() === email; })) {
        return sendError(res, 409, "Esse e-mail já está cadastrado.");
      }
      db.users.push(user);
      writeJsonDb(db);
    }
    await createSession(res, user.id, false);
    let created = user;
    if (pool) {
      const result = await pool.query("SELECT * FROM users WHERE id = $1", [user.id]);
      created = result.rows[0];
    }
    res.json({ user: publicUser(created, true) });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.post("/api/login", async function (req, res) {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const remember = Boolean(req.body.remember);
    let found = null;
    if (pool) {
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      found = result.rows[0] || null;
    } else {
      found = asList(readJsonDb().users).find(function (row) { return String(row.email).toLowerCase() === email; }) || null;
    }
    let ok = false;
    if (found) {
      const salt = Buffer.from(found.password_salt || found.passwordSalt, "base64");
      const hash = found.password_hash || found.passwordHash;
      ok = sameText(hashPassword(password, salt), hash);
    } else {
      hashPassword(password, crypto.randomBytes(16));
    }
    if (!ok) return sendError(res, 401, "E-mail ou senha incorretos.");
    await createSession(res, found.id, remember);
    res.json({ user: publicUser(found, true) });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.post("/api/logout", async function (req, res) {
  try {
    await destroySession(req, res);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.post("/api/forgot", async function (req, res) {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    let found = null;
    if (pool) {
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      found = result.rows[0] || null;
    } else {
      found = asList(readJsonDb().users).find(function (row) { return String(row.email).toLowerCase() === email; }) || null;
    }
    if (found) {
      const token = newSecret();
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      if (pool) {
        await pool.query(
          "INSERT INTO resets(token_hash, user_id, expires, used) VALUES ($1,$2,$3,FALSE)",
          [hashToken(token), found.id, expires]
        );
      } else {
        const db = readJsonDb();
        db.resets = asList(db.resets);
        db.resets.push({ tokenHash: hashToken(token), userId: found.id, expires: expires, used: false });
        writeJsonDb(db);
        fs.mkdirSync(localDir, { recursive: true });
        fs.appendFileSync(outboxPath, [new Date().toISOString(), email, token].join("\t") + "\n", "utf8");
      }
      console.log("[vexora] password reset token for", email, token);
    }
    res.json({
      ok: true,
      message: "Se esse e-mail estiver cadastrado, a recuperação fica disponível por 30 minutos."
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.post("/api/reset", async function (req, res) {
  try {
    const token = String(req.body.token || "");
    const password = String(req.body.password || "");
    const confirm = String(req.body.confirm || "");
    if (password.length < 8 || password.length > 72) {
      return sendError(res, 400, "A senha precisa ter entre 8 e 72 caracteres.");
    }
    if (password !== confirm) return sendError(res, 400, "A confirmação da senha não confere.");
    const hash = hashToken(token);
    const now = new Date().toISOString();
    let userId = null;
    if (pool) {
      const result = await pool.query(
        "SELECT * FROM resets WHERE token_hash = $1 AND used = FALSE AND expires > $2",
        [hash, now]
      );
      const row = result.rows[0];
      if (!row) return sendError(res, 400, "Esse link de recuperação expirou ou já foi usado.");
      userId = row.user_id;
      const salt = crypto.randomBytes(16);
      await pool.query(
        "UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3",
        [hashPassword(password, salt), salt.toString("base64"), userId]
      );
      await pool.query("UPDATE resets SET used = TRUE WHERE token_hash = $1", [hash]);
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    } else {
      const db = readJsonDb();
      const row = asList(db.resets).find(function (item) {
        return item.tokenHash === hash && !item.used && new Date(item.expires) > new Date();
      });
      if (!row) return sendError(res, 400, "Esse link de recuperação expirou ou já foi usado.");
      const user = asList(db.users).find(function (item) { return item.id === row.userId; });
      if (!user) return sendError(res, 400, "Esse link de recuperação expirou ou já foi usado.");
      const salt = crypto.randomBytes(16);
      user.passwordSalt = salt.toString("base64");
      user.passwordHash = hashPassword(password, salt);
      row.used = true;
      db.sessions = asList(db.sessions).filter(function (item) { return item.userId !== user.id; });
      writeJsonDb(db);
      userId = user.id;
    }
    await createSession(res, userId, false);
    const me = pool
      ? (await pool.query("SELECT * FROM users WHERE id = $1", [userId])).rows[0]
      : asList(readJsonDb().users).find(function (item) { return item.id === userId; });
    res.json({ user: publicUser(me, true) });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.get("/api/me", async function (req, res) {
  try {
    const user = await currentUser(req);
    if (!user) return sendError(res, 401, "Entre para continuar.");
    res.json({ user: publicUser(user, true) });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.patch("/api/me", async function (req, res) {
  try {
    const user = await currentUser(req);
    if (!user) return sendError(res, 401, "Entre para continuar.");
    const displayName = String(req.body.displayName || "").trim();
    const bio = String(req.body.bio || "").trim();
    const avatar = String(req.body.avatar || "").trim();
    if (displayName.length < 2 || displayName.length > 24) {
      return sendError(res, 400, "O nome de exibição precisa ter de 2 a 24 caracteres.");
    }
    if (bio.length > 140) return sendError(res, 400, "A descrição pode ter até 140 caracteres.");
    if (AVATARS.indexOf(avatar) === -1) return sendError(res, 400, "Escolha um dos avatares disponíveis.");
    if (pool) {
      await pool.query(
        "UPDATE users SET display_name = $1, bio = $2, avatar = $3 WHERE id = $4",
        [displayName, bio, avatar, user.id]
      );
      const result = await pool.query("SELECT * FROM users WHERE id = $1", [user.id]);
      return res.json({ user: publicUser(result.rows[0], true) });
    }
    const db = readJsonDb();
    const row = asList(db.users).find(function (item) { return item.id === user.id; });
    row.displayName = displayName;
    row.bio = bio;
    row.avatar = avatar;
    writeJsonDb(db);
    res.json({ user: publicUser(row, true) });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.post("/api/matches", async function (req, res) {
  try {
    const user = await currentUser(req);
    if (!user) return sendError(res, 401, "Entre para continuar.");
    const mode = String(req.body.mode || "");
    if (MODES.indexOf(mode) === -1) return sendError(res, 400, "Modo de jogo inválido.");
    const total = Math.max(0, Math.min(400, Number(req.body.total) || 0));
    const correct = Math.max(0, Math.min(total, Number(req.body.correct) || 0));
    const score = Math.max(0, Math.min(200000, Number(req.body.score) || 0));
    const streak = Math.max(0, Math.min(total, Number(req.body.streak) || 0));
    if (total < 1) return sendError(res, 400, "A partida não teve perguntas.");
    const xpGain = Math.min(8000, correct * 25 + Math.floor(score / 10));
    const now = new Date().toISOString();
    const accuracy = Math.round((100 * correct) / total);
    const entry = { mode: mode, score: score, correct: correct, total: total, streak: streak, date: now };

    if (pool) {
      const result = await pool.query("SELECT * FROM users WHERE id = $1", [user.id]);
      const row = result.rows[0];
      const best = ensureBest(row.best);
      if (score >= best[mode].score) best[mode] = { score: score, accuracy: accuracy, date: now };
      let achievements = asList(row.achievements);
      achievements = addAchievement(achievements, "primeira_partida");
      if (streak >= 5) achievements = addAchievement(achievements, "sequencia_5");
      if (streak >= 10) achievements = addAchievement(achievements, "sequencia_10");
      if (score >= 1000) achievements = addAchievement(achievements, "recorde_1000");
      if (mode === "classic" && correct === total && total >= 10) achievements = addAchievement(achievements, "classico_perfeito");
      const played = Number(row.played) + 1;
      if (played >= 10) achievements = addAchievement(achievements, "dez_partidas");
      let history = asList(row.history);
      history.unshift(entry);
      history = history.slice(0, 30);
      await pool.query(
        `UPDATE users SET xp = $1, played = $2, correct = $3, answered = $4, best_streak = $5,
         best = $6::jsonb, achievements = $7::jsonb, history = $8::jsonb WHERE id = $9`,
        [
          Number(row.xp) + xpGain,
          played,
          Number(row.correct) + correct,
          Number(row.answered) + total,
          Math.max(Number(row.best_streak), streak),
          JSON.stringify(best),
          JSON.stringify(achievements),
          JSON.stringify(history),
          row.id
        ]
      );
      const updated = (await pool.query("SELECT * FROM users WHERE id = $1", [row.id])).rows[0];
      return res.json({ user: publicUser(updated, true), xpGain: xpGain });
    }

    const db = readJsonDb();
    const row = asList(db.users).find(function (item) { return item.id === user.id; });
    row.xp = Number(row.xp || 0) + xpGain;
    row.played = Number(row.played || 0) + 1;
    row.correct = Number(row.correct || 0) + correct;
    row.answered = Number(row.answered || 0) + total;
    row.bestStreak = Math.max(Number(row.bestStreak || 0), streak);
    row.best = ensureBest(row.best);
    if (score >= row.best[mode].score) row.best[mode] = { score: score, accuracy: accuracy, date: now };
    row.history = asList(row.history);
    row.history.unshift(entry);
    row.history = row.history.slice(0, 30);
    row.achievements = addAchievement(row.achievements, "primeira_partida");
    if (streak >= 5) row.achievements = addAchievement(row.achievements, "sequencia_5");
    if (streak >= 10) row.achievements = addAchievement(row.achievements, "sequencia_10");
    if (score >= 1000) row.achievements = addAchievement(row.achievements, "recorde_1000");
    if (mode === "classic" && correct === total && total >= 10) row.achievements = addAchievement(row.achievements, "classico_perfeito");
    if (row.played >= 10) row.achievements = addAchievement(row.achievements, "dez_partidas");
    writeJsonDb(db);
    res.json({ user: publicUser(row, true), xpGain: xpGain });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.get("/api/history", async function (req, res) {
  try {
    const user = await currentUser(req);
    if (!user) return sendError(res, 401, "Entre para continuar.");
    res.json({ history: asList(user.history) });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.get("/api/ranking", async function (req, res) {
  try {
    const user = await currentUser(req);
    if (!user) return sendError(res, 401, "Entre para continuar.");
    const mode = String(req.query.mode || "all");
    let users = [];
    if (pool) {
      users = (await pool.query("SELECT * FROM users")).rows;
    } else {
      users = asList(readJsonDb().users);
    }
    const ranking = [];
    users.forEach(function (row) {
      const best = ensureBest(row.best);
      let picked = null;
      if (MODES.indexOf(mode) !== -1) {
        if (best[mode].score > 0) picked = { mode: mode, score: best[mode].score, accuracy: best[mode].accuracy, date: best[mode].date };
      } else {
        MODES.forEach(function (item) {
          if (best[item].score > 0 && (!picked || best[item].score > picked.score)) {
            picked = { mode: item, score: best[item].score, accuracy: best[item].accuracy, date: best[item].date };
          }
        });
      }
      if (picked) {
        ranking.push({
          userId: String(row.id),
          name: String(row.display_name || row.displayName || row.username),
          username: String(row.username),
          avatar: String(row.avatar || "compass"),
          level: levelOf(row.xp),
          mode: picked.mode,
          score: picked.score,
          accuracy: picked.accuracy,
          date: picked.date
        });
      }
    });
    ranking.sort(function (a, b) { return b.score - a.score; });
    res.json({ ranking: ranking });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.get("/api/users/search", async function (req, res) {
  try {
    const user = await currentUser(req);
    if (!user) return sendError(res, 401, "Entre para continuar.");
    const query = String(req.query.q || "").trim().toLowerCase();
    if (query.length < 2) return res.json({ users: [] });
    let users = [];
    if (pool) {
      users = (await pool.query(
        `SELECT id, username, display_name, avatar, xp FROM users
         WHERE id <> $1 AND (lower(username) LIKE $2 OR lower(display_name) LIKE $2)
         LIMIT 12`,
        [user.id, "%" + query + "%"]
      )).rows;
    } else {
      users = asList(readJsonDb().users)
        .filter(function (row) {
          if (row.id === user.id) return false;
          const hay = (row.username + " " + (row.displayName || "")).toLowerCase();
          return hay.indexOf(query) !== -1;
        })
        .slice(0, 12);
    }
    res.json({
      users: users.map(function (row) {
        return {
          id: String(row.id),
          username: String(row.username),
          displayName: String(row.display_name || row.displayName || row.username),
          avatar: String(row.avatar || "compass"),
          level: levelOf(row.xp)
        };
      })
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.get("/api/users/:id", async function (req, res) {
  try {
    const me = await currentUser(req);
    if (!me) return sendError(res, 401, "Entre para continuar.");
    let found = null;
    if (pool) {
      found = (await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id])).rows[0] || null;
    } else {
      found = asList(readJsonDb().users).find(function (row) { return row.id === req.params.id; }) || null;
    }
    if (!found) return sendError(res, 404, "Jogador não encontrado.");
    res.json({ user: publicUser(found, found.id === me.id) });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

async function loadUserById(id) {
  if (pool) {
    return (await pool.query("SELECT * FROM users WHERE id = $1", [id])).rows[0] || null;
  }
  return asList(readJsonDb().users).find(function (row) { return row.id === id; }) || null;
}

app.get("/api/friends", async function (req, res) {
  try {
    const me = await currentUser(req);
    if (!me) return sendError(res, 401, "Entre para continuar.");
    let requests = [];
    if (pool) {
      requests = (await pool.query("SELECT * FROM friend_requests")).rows.map(function (row) {
        return { id: row.id, fromId: row.from_id, toId: row.to_id, status: row.status, createdAt: row.created_at };
      });
    } else {
      requests = asList(readJsonDb().requests);
    }
    const friends = [];
    const incoming = [];
    const outgoing = [];
    for (const request of requests) {
      const from = await loadUserById(request.fromId);
      const to = await loadUserById(request.toId);
      if (!from || !to) continue;
      if (request.status === "accepted" && (request.fromId === me.id || request.toId === me.id)) {
        const other = request.fromId === me.id ? to : from;
        friends.push({ requestId: request.id, user: publicUser(other, false) });
      }
      if (request.status === "pending" && request.toId === me.id) {
        incoming.push({ requestId: request.id, user: publicUser(from, false) });
      }
      if (request.status === "pending" && request.fromId === me.id) {
        outgoing.push({ requestId: request.id, user: publicUser(to, false) });
      }
    }
    res.json({ friends: friends, incoming: incoming, outgoing: outgoing });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.post("/api/friends", async function (req, res) {
  try {
    const me = await currentUser(req);
    if (!me) return sendError(res, 401, "Entre para continuar.");
    const targetId = String(req.body.userId || "");
    if (targetId === me.id) return sendError(res, 400, "Você não pode adicionar a si mesmo.");
    const target = await loadUserById(targetId);
    if (!target) return sendError(res, 404, "Jogador não encontrado.");

    if (pool) {
      const existing = await pool.query(
        `SELECT * FROM friend_requests
         WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
         ORDER BY created_at DESC`,
        [me.id, targetId]
      );
      for (const row of existing.rows) {
        if (row.status === "accepted") return sendError(res, 409, "Vocês já são amigos.");
        if (row.status === "pending" && row.from_id === me.id) return sendError(res, 409, "O pedido já foi enviado.");
        if (row.status === "pending" && row.to_id === me.id) {
          await pool.query("UPDATE friend_requests SET status = 'accepted' WHERE id = $1", [row.id]);
          for (const uid of [me.id, targetId]) {
            const person = await loadUserById(uid);
            const achievements = addAchievement(person.achievements, "primeiro_amigo");
            await pool.query("UPDATE users SET achievements = $1::jsonb WHERE id = $2", [JSON.stringify(achievements), uid]);
          }
          await addNote(targetId, "friend", me.id, (me.display_name || me.displayName || me.username) + " aceitou sua solicitação.");
          return res.json({ ok: true, status: "accepted" });
        }
      }
      const id = newId();
      await pool.query(
        "INSERT INTO friend_requests(id, from_id, to_id, status, created_at) VALUES ($1,$2,$3,'pending',$4)",
        [id, me.id, targetId, new Date().toISOString()]
      );
      await addNote(targetId, "request", me.id, (me.display_name || me.displayName || me.username) + " enviou uma solicitação de amizade.");
      return res.json({ ok: true, status: "pending" });
    }

    const db = readJsonDb();
    db.requests = asList(db.requests);
    for (const request of db.requests) {
      const pair = (request.fromId === me.id && request.toId === targetId) || (request.toId === me.id && request.fromId === targetId);
      if (!pair) continue;
      if (request.status === "accepted") return sendError(res, 409, "Vocês já são amigos.");
      if (request.status === "pending" && request.fromId === me.id) return sendError(res, 409, "O pedido já foi enviado.");
      if (request.status === "pending" && request.toId === me.id) {
        request.status = "accepted";
        const from = asList(db.users).find(function (item) { return item.id === me.id; });
        const to = asList(db.users).find(function (item) { return item.id === targetId; });
        from.achievements = addAchievement(from.achievements, "primeiro_amigo");
        to.achievements = addAchievement(to.achievements, "primeiro_amigo");
        db.notes = asList(db.notes);
        db.notes.push({
          id: newId(), userId: targetId, kind: "friend", fromId: me.id,
          text: (me.displayName || me.username) + " aceitou sua solicitação.",
          read: false, createdAt: new Date().toISOString()
        });
        writeJsonDb(db);
        return res.json({ ok: true, status: "accepted" });
      }
    }
    db.requests.push({
      id: newId(), fromId: me.id, toId: targetId, status: "pending", createdAt: new Date().toISOString()
    });
    db.notes = asList(db.notes);
    db.notes.push({
      id: newId(), userId: targetId, kind: "request", fromId: me.id,
      text: (me.displayName || me.username) + " enviou uma solicitação de amizade.",
      read: false, createdAt: new Date().toISOString()
    });
    writeJsonDb(db);
    res.json({ ok: true, status: "pending" });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.post("/api/friends/:id", async function (req, res) {
  try {
    const me = await currentUser(req);
    if (!me) return sendError(res, 401, "Entre para continuar.");
    const action = String(req.body.action || "");
    const requestId = req.params.id;

    if (pool) {
      const result = await pool.query("SELECT * FROM friend_requests WHERE id = $1", [requestId]);
      const request = result.rows[0];
      if (!request || request.status !== "pending") return sendError(res, 404, "Solicitação não encontrada.");
      const isRecipient = request.to_id === me.id;
      const isSender = request.from_id === me.id;
      if (action === "accept" || action === "decline") {
        if (!isRecipient) return sendError(res, 403, "Só quem recebeu pode responder.");
        await pool.query("UPDATE friend_requests SET status = $1 WHERE id = $2", [action === "accept" ? "accepted" : "declined", requestId]);
        if (action === "accept") {
          for (const uid of [request.from_id, request.to_id]) {
            const person = await loadUserById(uid);
            const achievements = addAchievement(person.achievements, "primeiro_amigo");
            await pool.query("UPDATE users SET achievements = $1::jsonb WHERE id = $2", [JSON.stringify(achievements), uid]);
          }
          await addNote(request.from_id, "friend", me.id, (me.display_name || me.username) + " aceitou sua solicitação.");
        }
        return res.json({ ok: true });
      }
      if (action === "cancel") {
        if (!isSender) return sendError(res, 403, "Só quem enviou pode cancelar.");
        await pool.query("UPDATE friend_requests SET status = 'cancelled' WHERE id = $1", [requestId]);
        return res.json({ ok: true });
      }
      return sendError(res, 400, "Ação inválida.");
    }

    const db = readJsonDb();
    const request = asList(db.requests).find(function (item) { return item.id === requestId; });
    if (!request || request.status !== "pending") return sendError(res, 404, "Solicitação não encontrada.");
    if (action === "accept" || action === "decline") {
      if (request.toId !== me.id) return sendError(res, 403, "Só quem recebeu pode responder.");
      request.status = action === "accept" ? "accepted" : "declined";
      if (action === "accept") {
        const from = asList(db.users).find(function (item) { return item.id === request.fromId; });
        const to = asList(db.users).find(function (item) { return item.id === request.toId; });
        from.achievements = addAchievement(from.achievements, "primeiro_amigo");
        to.achievements = addAchievement(to.achievements, "primeiro_amigo");
        db.notes = asList(db.notes);
        db.notes.push({
          id: newId(), userId: request.fromId, kind: "friend", fromId: me.id,
          text: (me.displayName || me.username) + " aceitou sua solicitação.",
          read: false, createdAt: new Date().toISOString()
        });
      }
      writeJsonDb(db);
      return res.json({ ok: true });
    }
    if (action === "cancel") {
      if (request.fromId !== me.id) return sendError(res, 403, "Só quem enviou pode cancelar.");
      request.status = "cancelled";
      writeJsonDb(db);
      return res.json({ ok: true });
    }
    sendError(res, 400, "Ação inválida.");
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.delete("/api/friends/:id", async function (req, res) {
  try {
    const me = await currentUser(req);
    if (!me) return sendError(res, 401, "Entre para continuar.");
    if (pool) {
      const result = await pool.query("SELECT * FROM friend_requests WHERE id = $1", [req.params.id]);
      const request = result.rows[0];
      if (!request || request.status !== "accepted") return sendError(res, 404, "Amizade não encontrada.");
      if (request.from_id !== me.id && request.to_id !== me.id) {
        return sendError(res, 403, "Você não participa dessa amizade.");
      }
      await pool.query("DELETE FROM friend_requests WHERE id = $1", [req.params.id]);
      return res.json({ ok: true });
    }
    const db = readJsonDb();
    const request = asList(db.requests).find(function (item) { return item.id === req.params.id; });
    if (!request || request.status !== "accepted") return sendError(res, 404, "Amizade não encontrada.");
    if (request.fromId !== me.id && request.toId !== me.id) {
      return sendError(res, 403, "Você não participa dessa amizade.");
    }
    db.requests = asList(db.requests).filter(function (item) { return item.id !== req.params.id; });
    writeJsonDb(db);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.get("/api/notifications", async function (req, res) {
  try {
    const me = await currentUser(req);
    if (!me) return sendError(res, 401, "Entre para continuar.");
    let notes = [];
    if (pool) {
      notes = (await pool.query(
        "SELECT id, text, read, created_at FROM notes WHERE user_id = $1 ORDER BY created_at ASC",
        [me.id]
      )).rows.map(function (row) {
        return { id: row.id, text: row.text, read: row.read, createdAt: row.created_at };
      });
    } else {
      notes = asList(readJsonDb().notes)
        .filter(function (row) { return row.userId === me.id; })
        .map(function (row) {
          return { id: row.id, text: row.text, read: Boolean(row.read), createdAt: row.createdAt };
        });
    }
    res.json({ notifications: notes });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.post("/api/notifications/read", async function (req, res) {
  try {
    const me = await currentUser(req);
    if (!me) return sendError(res, 401, "Entre para continuar.");
    if (pool) {
      await pool.query("UPDATE notes SET read = TRUE WHERE user_id = $1", [me.id]);
    } else {
      const db = readJsonDb();
      asList(db.notes).forEach(function (row) {
        if (row.userId === me.id) row.read = true;
      });
      writeJsonDb(db);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Não foi possível concluir agora. Tente de novo.");
  }
});

app.use(function (req, res, next) {
  if (req.path === "/server" || req.path.indexOf("/server/") === 0) {
    return res.status(404).send("Nao encontrado");
  }
  next();
});

app.use(express.static(ROOT));

app.use(function (_req, res) {
  res.status(404).send("Nao encontrado");
});

async function start() {
  if (pool) {
    await initPostgres();
    console.log("VEXORA_READY postgres port=" + PORT);
  } else {
    fs.mkdirSync(localDir, { recursive: true });
    console.log("VEXORA_READY file-db port=" + PORT);
  }
  app.listen(PORT, "0.0.0.0", function () {
    console.log("listening on " + PORT);
  });
}

start().catch(function (err) {
  console.error(err);
  process.exit(1);
});
