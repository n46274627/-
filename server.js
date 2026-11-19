const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();
const GAME_LENGTH = 30 * 60;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function id() {
  return crypto.randomUUID();
}

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function clean(value, max = 100) {
  return String(value ?? "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, max);
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[׳״'".,!?־\-_\s]/g, "");
}

function editDistanceOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }

    edits++;
    if (edits > 1) return false;

    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }

  if (i < a.length || j < b.length) edits++;
  return edits <= 1;
}

function isCorrectGuess(guess, realName) {
  const normalizedGuess = normalizeName(guess);
  const words = String(realName)
    .trim()
    .split(/\s+/)
    .map(normalizeName)
    .filter(Boolean);

  if (!normalizedGuess || !words.length) return false;

  return words.some(word => editDistanceOne(normalizedGuess, word));
}

function getRoom(socket) {
  return socket.data.roomCode
    ? rooms.get(socket.data.roomCode)
    : null;
}

function getPlayer(socket) {
  const room = getRoom(socket);
  if (!room) return null;
  return room.players.get(socket.data.playerId) || null;
}

function remainingSeconds(room) {
  if (!room.deadline) return GAME_LENGTH;
  return Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000));
}

function timePoints(room) {
  const seconds = remainingSeconds(room);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes * 100 + rest;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function canTarget(guesser, targetId) {
  if (!guesser || guesser.id === targetId) return false;
  if (guesser.correctTargets.has(targetId)) return false;
  return (guesser.attempts.get(targetId) || 0) < 2;
}

function canAskAbout(guesser, targetId) {
  return canTarget(guesser, targetId);
}

function hasAnyGuessOpportunity(room) {
  const players = [...room.players.values()];

  for (const guesser of players) {
    for (const target of players) {
      if (canTarget(guesser, target.id)) return true;
    }
  }

  return false;
}

function addMessage(room, text, system = true, alias = "") {
  room.messages.push({
    id: id(),
    system,
    alias,
    text,
    time: Date.now()
  });

  room.messages = room.messages.slice(-100);
}

function publicState(room, player) {
  const players = [...room.players.values()].map(p => ({
    id: p.id,
    alias: p.alias,
    connected: p.connected,
    score: p.score,
    isHost: p.id === room.hostId
  }));

  const attempts = {};
  const blockedTargets = [];

  for (const target of players) {
    attempts[target.id] = player.attempts.get(target.id) || 0;

    if (
      player.correctTargets.has(target.id) ||
      (player.attempts.get(target.id) || 0) >= 2
    ) {
      blockedTargets.push(target.id);
    }
  }

  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players,
    messages: room.messages,
    currentTurnId: room.currentTurnId,
    round: room.round,
    remaining: remainingSeconds(room),
    timeLabel: formatTime(remainingSeconds(room)),
    myId: player.id,
    myScore: player.score,
    attempts,
    blockedTargets,
    privateQuestions: player.questions,
    pendingQuestion: player.pendingQuestion,
    knownDetails: player.knownDetails,
    guessLog: room.guessLog,
    revealStep: room.revealStep,
    reveal: room.status === "finished"
      ? players.map(p => {
          const original = room.players.get(p.id);
          return {
            id: p.id,
            alias: p.alias,
            realName: original.realName,
            score: original.score
          };
        })
      : null
  };
}

function sendState(room) {
  for (const player of room.players.values()) {
    for (const socketId of player.sockets) {
      io.to(socketId).emit("state", publicState(room, player));
    }
  }
}

function nextTurn(room) {
  if (room.status !== "playing") return;

  const order = room.turnOrder;
  if (!order.length) return;

  for (let i = 0; i < order.length; i++) {
    room.turnIndex++;

    if (room.turnIndex >= order.length) {
      room.turnIndex = 0;
      room.round++;
    }

    const candidateId = order[room.turnIndex];
    const candidate = room.players.get(candidateId);

    if (!candidate || !candidate.connected) continue;

    const hasTarget = [...room.players.values()].some(target =>
      canAskAbout(candidate, target.id)
    );

    if (hasTarget) {
      room.currentTurnId = candidateId;
      sendState(room);
      return;
    }
  }

  room.currentTurnId = null;
  sendState(room);
}

function finishGame(room, reason) {
  if (!room || room.status === "finished") return;

  room.status = "finished";
  room.currentTurnId = null;
  room.finishedReason = reason;
  room.revealStep = 0;

  addMessage(
    room,
    reason === "time"
      ? "הזמן נגמר! המשחק הסתיים."
      : "כל אפשרויות הניחוש נוצלו! המשחק הסתיים."
  );

  sendState(room);
}

function attachPlayer(socket, room, player) {
  player.connected = true;
  player.sockets.add(socket.id);

  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);

  sendState(room);
}

function leaveOldRoom(socket) {
  const oldRoom = getRoom(socket);
  if (!oldRoom) return;

  const player = getPlayer(socket);
  socket.leave(oldRoom.code);

  if (player) {
    player.sockets.delete(socket.id);
    if (player.sockets.size === 0) {
      player.connected = false;
    }
  }

  if (oldRoom.hostId === player?.id) {
    const nextHost = [...oldRoom.players.values()].find(p => p.connected);
    if (nextHost) oldRoom.hostId = nextHost.id;
  }

  if (oldRoom.players.size === 0) {
    rooms.delete(oldRoom.code);
  } else {
    sendState(oldRoom);
  }

  socket.data.roomCode = null;
  socket.data.playerId = null;
}

function createPlayer(browserId, realName, alias) {
  return {
    id: browserId,
    realName,
    alias,
    connected: true,
    sockets: new Set(),
    score: 0,
    attempts: new Map(),
    correctTargets: new Set(),
    questions: [],
    pendingQuestion: null,
    knownDetails: []
  };
}

io.on("connection", socket => {
  socket.on("createRoom", ({ realName, alias, browserId }, callback = () => {}) => {
    realName = clean(realName, 48);
    alias = clean(alias, 24);
    browserId = clean(browserId, 80);

    if (!realName || !alias || !browserId) {
      return callback({ error: "צריך למלא שם אמיתי, שם בדוי ולרענן את הדפדפן אם צריך." });
    }

    leaveOldRoom(socket);

    const code = makeCode();
    const player = createPlayer(browserId, realName, alias);

    const room = {
      code,
      hostId: player.id,
      status: "lobby",
      players: new Map([[player.id, player]]),
      messages: [],
      turnOrder: [],
      turnIndex: -1,
      currentTurnId: null,
      round: 0,
      deadline: null,
      guessLog: [],
      revealStep: 0,
      finishedReason: null
    };

    rooms.set(code, room);
    attachPlayer(socket, room, player);

    callback({ ok: true, code });
    sendState(room);
  });

  socket.on("joinRoom", ({ code, realName, alias, browserId }, callback = () => {}) => {
    code = clean(code, 5).toUpperCase();
    realName = clean(realName, 48);
    alias = clean(alias, 24);
    browserId = clean(browserId, 80);

    const room = rooms.get(code);

    if (!room) return callback({ error: "לא מצאתי חדר עם הקוד הזה." });
    if (!realName || !alias || !browserId) {
      return callback({ error: "צריך למלא את כל הפרטים." });
    }

    const existing = room.players.get(browserId);

    if (existing) {
      leaveOldRoom(socket);
      attachPlayer(socket, room, existing);
      return callback({ ok: true, code, resumed: true });
    }

    if (room.status !== "lobby") {
      return callback({ error: "המשחק כבר התחיל. אפשר לחזור רק עם הדפדפן שבו הצטרפת." });
    }

    if (room.players.size >= 20) {
      return callback({ error: "החדר מלא (עד 20 שחקנים)." });
    }

    const aliasTaken = [...room.players.values()].some(
      p => p.alias.toLowerCase() === alias.toLowerCase()
    );

    if (aliasTaken) {
      return callback({ error: "השם הבדוי הזה כבר תפוס. בחר שם אחר." });
    }

    leaveOldRoom(socket);

    const player = createPlayer(browserId, realName, alias);
    room.players.set(player.id, player);

    attachPlayer(socket, room, player);
    callback({ ok: true, code });
    sendState(room);
  });

  socket.on("resumeRoom", ({ code, browserId }, callback = () => {}) => {
    code = clean(code, 5).toUpperCase();
    browserId = clean(browserId, 80);

    const room = rooms.get(code);
    const player = room?.players.get(browserId);

    if (!room || !player) {
      return callback({ error: "לא נמצאו פרטי משחק קודמים בדפדפן הזה." });
    }

    leaveOldRoom(socket);
    attachPlayer(socket, room, player);

    callback({ ok: true, code });
  });

  socket.on("startGame", callback => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player) return callback?.({ error: "אין חדר פעיל." });
    if (room.hostId !== player.id) {
      return callback?.({ error: "רק מנהל החדר יכול להתחיל." });
    }
    if (room.players.size < 2) {
      return callback?.({ error: "צריך לפחות שני שחקנים." });
    }

    if (room.status !== "lobby") {
      return callback?.({ error: "המשחק כבר התחיל." });
    }

    room.status = "playing";
    room.deadline = Date.now() + GAME_LENGTH * 1000;
    room.turnOrder = [...room.players.keys()].sort(() => Math.random() - 0.5);
    room.turnIndex = -1;
    room.round = 1;

    addMessage(room, "המשחק התחיל! כל שחקן יקבל תור לשאול שאלה אחת.");

    nextTurn(room);
    callback?.({ ok: true });
  });

  socket.on("askQuestion", ({ targetId, question }, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);
    const target = room?.players.get(targetId);

    question = clean(question, 240);

    if (!room || room.status !== "playing" || !player || !target) {
      return callback({ error: "אי אפשר לשלוח שאלה כרגע." });
    }

    if (room.currentTurnId !== player.id) {
      return callback({ error: "זה לא התור שלך." });
    }

    if (target.id === player.id) {
      return callback({ error: "אי אפשר לשאול את עצמך." });
    }

    if (!canAskAbout(player, target.id)) {
      return callback({ error: "כבר אי אפשר לשאול את השחקן הזה." });
    }

    if (player.pendingQuestion) {
      return callback({ error: "יש לך שאלה שממתינה לתשובה." });
    }

    if (!question) return callback({ error: "צריך לכתוב שאלה." });

    const questionData = {
      id: id(),
      fromId: player.id,
      fromAlias: player.alias,
      toId: target.id,
      toAlias: target.alias,
      text: question,
      answer: null,
      time: Date.now()
    };

    target.pendingQuestion = questionData;
    target.questions.unshift(questionData);

    addMessage(room, `${player.alias} שאל את ${target.alias}: "${question}"`);
    room.currentTurnId = null;

    sendState(room);
    callback({ ok: true });

    setTimeout(() => {
      if (room.status === "playing" && !room.currentTurnId) {
        nextTurn(room);
      }
    }, 300);
  });

  socket.on("answerQuestion", ({ questionId, answer }, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || room.status !== "playing" || !player) {
      return callback({ error: "אי אפשר לענות כרגע." });
    }

    const question = player.pendingQuestion;

    if (!question || question.id !== questionId) {
      return callback({ error: "השאלה כבר לא ממתינה לתשובה." });
    }

    if (answer !== "yes" && answer !== "no") {
      return callback({ error: "תשובה לא תקינה." });
    }

    question.answer = answer;
    question.answeredAt = Date.now();

    const saved = player.questions.find(q => q.id === question.id);
    if (saved) {
      saved.answer = answer;
      saved.answeredAt = question.answeredAt;
    }

    if (answer === "yes") {
      player.knownDetails.unshift(question.text);
    }

    addMessage(
      room,
      `${player.alias} ענה ${answer === "yes" ? "כן" : "לא"} לשאלה של ${question.fromAlias}: "${question.text}"`
    );

    player.pendingQuestion = null;
    sendState(room);
    callback({ ok: true });
  });

  socket.on("chat", ({ text }, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    text = clean(text, 240);

    if (!room || !player || room.status !== "playing") {
      return callback?.({ error: "אי אפשר לשלוח הודעה כרגע." });
    }

    if (!text) return;

    addMessage(room, text, false, player.alias);
    sendState(room);
    callback?.({ ok: true });
  });

  socket.on("guess", ({ targetId, realNameGuess }, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);
    const target = room?.players.get(targetId);

    realNameGuess = clean(realNameGuess, 48);

    if (!room || room.status !== "playing" || !player || !target) {
      return callback({ error: "הניחוש לא זמין כרגע." });
    }

    if (target.id === player.id) {
      return callback({ error: "אי אפשר לנחש את עצמך." });
    }

    if (!canTarget(player, target.id)) {
      return callback({ error: "כבר ניצלת את אפשרויות הניחוש שלך על השחקן הזה." });
    }

    if (!realNameGuess) {
      return callback({ error: "כתוב שם לניחוש." });
    }

    const attemptNumber = (player.attempts.get(target.id) || 0) + 1;
    player.attempts.set(target.id, attemptNumber);

    const correct = isCorrectGuess(realNameGuess, target.realName);
    const secondsLeft = remainingSeconds(room);
    const points = correct ? timePoints(room) : 0;

    if (correct) {
      player.correctTargets.add(target.id);
      player.score += points;
    }

    const guessRecord = {
      id: id(),
      guesserId: player.id,
      guesserAlias: player.alias,
      targetId: target.id,
      targetAlias: target.alias,
      guess: realNameGuess,
      correct,
      points,
      timeLeft: formatTime(secondsLeft),
      secondsLeft,
      attemptNumber
    };

    room.guessLog.push(guessRecord);

    addMessage(
      room,
      correct
        ? `${player.alias} הצליח לנחש את ${target.alias}! (+${points} נקודות)`
        : `${player.alias} ניסה לנחש את ${target.alias}, אך הניחוש לא הצליח.`
    );

    if (!hasAnyGuessOpportunity(room)) {
      finishGame(room, "guesses");
    } else {
      sendState(room);
    }

    callback({ ok: true, correct, points, attemptsLeft: 2 - attemptNumber });
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player) return;

    player.sockets.delete(socket.id);
    player.connected = player.sockets.size > 0;

    if (room.hostId === player.id && !player.connected) {
      const nextHost = [...room.players.values()].find(p => p.connected);
      if (nextHost) room.hostId = nextHost.id;
    }

    if (room.currentTurnId === player.id && !player.connected) {
      nextTurn(room);
    }

    sendState(room);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status !== "playing") continue;

    if (remainingSeconds(room) <= 0) {
      finishGame(room, "time");
    } else {
      sendState(room);
    }
  }
}, 1000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Identity Mystery is running on http://localhost:${PORT}`);
});
