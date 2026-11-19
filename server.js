const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const GAME_LENGTH_SECONDS = 30 * 60;
const MAX_PLAYERS = 20;
const rooms = new Map();

function createId() {
  return crypto.randomUUID();
}

function clean(value, maxLength = 200) {
  return String(value ?? "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, maxLength);
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = Array.from({ length: 5 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[׳״'".,!?־\-_\s]/g, "");
}

function editDistanceAtMostOne(a, b) {
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

    if (a.length > b.length) {
      i++;
    } else if (b.length > a.length) {
      j++;
    } else {
      i++;
      j++;
    }
  }

  if (i < a.length || j < b.length) edits++;

  return edits <= 1;
}

function isCorrectGuess(guess, secretName) {
  const normalizedGuess = normalizeName(guess);

  const secretWords = String(secretName ?? "")
    .trim()
    .split(/\s+/)
    .map(normalizeName)
    .filter(Boolean);

  if (!normalizedGuess || secretWords.length === 0) {
    return false;
  }

  return secretWords.some(word =>
    editDistanceAtMostOne(normalizedGuess, word)
  );
}

function getRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) || null : null;
}

function getPlayer(socket) {
  const room = getRoom(socket);
  if (!room) return null;

  return room.players.get(socket.data.playerId) || null;
}

function activePlayers(room) {
  return [...room.players.values()].filter(player => player.inGame);
}

function remainingSeconds(room) {
  if (!room.deadline) return GAME_LENGTH_SECONDS;

  return Math.max(
    0,
    Math.ceil((room.deadline - Date.now()) / 1000)
  );
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return (
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0")
  );
}

function calculatePoints(room) {
  const seconds = remainingSeconds(room);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return minutes * 100 + rest;
}

function createPlayer(browserId, alias, realName) {
  return {
    id: browserId,
    alias,
    realName,

    connected: true,
    sockets: new Set(),

    inGame: true,
    replayStatus: "accepted",
    replayPrompt: false,

    score: 0,
    attempts: new Map(),
    correctTargets: new Set(),

    questions: [],
    pendingQuestion: null,
    knownDetails: [],

    revealStep: 0
  };
}

function resetPlayerForNewGame(player) {
  player.realName = "";
  player.score = 0;
  player.attempts = new Map();
  player.correctTargets = new Set();
  player.questions = [];
  player.pendingQuestion = null;
  player.knownDetails = [];
  player.revealStep = 0;

  player.inGame = false;
  player.replayStatus = "pending";
  player.replayPrompt = true;
}

function canAskAbout(room, asker, targetId) {
  const target = room.players.get(targetId);

  if (!target || !target.inGame) return false;
  if (!asker || !asker.inGame) return false;
  if (asker.id === targetId) return false;
  if (asker.correctTargets.has(targetId)) return false;

  const attempts = asker.attempts.get(targetId) || 0;
  return attempts < 2;
}

function hasAnyGuessOpportunity(room) {
  const players = activePlayers(room);

  for (const guesser of players) {
    for (const target of players) {
      if (canAskAbout(room, guesser, target.id)) {
        return true;
      }
    }
  }

  return false;
}

function hasUnansweredQuestion(room) {
  return room.questionHistory.some(question => question.answer === null);
}

// הודעה זמנית בצד המסך, לא הודעה בצ'אט.
function notifyRoom(room, message, type = "info") {
  for (const player of room.players.values()) {
    for (const socketId of player.sockets) {
      io.to(socketId).emit("gameNotification", {
        id: createId(),
        message,
        type,
        duration: 8000
      });
    }
  }
}

function addChatMessage(room, text, alias = "") {
  room.messages.push({
    id: createId(),
    text,
    system: false,
    alias,
    time: Date.now()
  });

  room.messages = room.messages.slice(-150);
}

function publicState(room, player) {
  const players = [...room.players.values()].map(p => ({
    id: p.id,
    alias: p.alias,
    connected: p.connected,
    score: p.score,
    isHost: p.id === room.hostId,
    identityReady: Boolean(p.realName),
    inGame: p.inGame,
    replayStatus: p.replayStatus
  }));

  const attempts = {};
  const blockedTargets = [];

  for (const target of activePlayers(room)) {
    attempts[target.id] = player.attempts.get(target.id) || 0;

    if (!canAskAbout(room, player, target.id)) {
      blockedTargets.push(target.id);
    }
  }

  const finished = room.status === "finished";
  const active = activePlayers(room);

  const allIdentitiesReady =
    active.length >= 2 &&
    active.every(p => Boolean(p.realName));

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

    myRealName: player.realName,

    attempts,
    blockedTargets,

    privateQuestions: player.questions,
    pendingQuestion: player.pendingQuestion,
    knownDetails: player.knownDetails,

    questionHistory: room.questionHistory.map(question => ({
      id: question.id,
      fromId: question.fromId,
      fromAlias: question.fromAlias,
      toId: question.toId,
      toAlias: question.toAlias,
      text: question.text,
      answer: question.answer,
      time: question.time,
      answeredAt: question.answeredAt
    })),

    guessLog: finished ? room.guessLog : [],

    revealStep: player.revealStep,

    reveal:
      finished && player.revealStep > room.guessLog.length
        ? active.map(p => ({
            id: p.id,
            alias: p.alias,
            realName: p.realName,
            score: p.score
          }))
        : null,

    finishedReason: room.finishedReason,

    replayPrompt: player.replayPrompt,
    replayStatus: player.replayStatus,
    allIdentitiesReady
  };
}

function sendState(room) {
  for (const player of room.players.values()) {
    for (const socketId of player.sockets) {
      io.to(socketId).emit("state", publicState(room, player));
    }
  }
}

function attachPlayer(socket, room, player) {
  player.connected = true;
  player.sockets.add(socket.id);

  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;

  socket.join(room.code);

  // אם המשחק ממתין לתור בגלל ניתוק, ננסה לבחור שחקן.
  if (
    room.status === "playing" &&
    room.currentTurnId === null &&
    !hasUnansweredQuestion(room)
  ) {
    nextTurn(room);
  }

  sendState(room);
}

function removeSocketFromCurrentRoom(socket) {
  const room = getRoom(socket);
  const player = getPlayer(socket);

  if (!room || !player) {
    socket.data.roomCode = null;
    socket.data.playerId = null;
    return;
  }

  player.sockets.delete(socket.id);
  player.connected = player.sockets.size > 0;

  socket.leave(room.code);

  if (room.hostId === player.id && !player.connected) {
    const nextHost = [...room.players.values()].find(p => p.connected);

    if (nextHost) room.hostId = nextHost.id;
  }

  if (
    room.status === "playing" &&
    room.currentTurnId === player.id &&
    !player.connected
  ) {
    nextTurn(room);
  }

  socket.data.roomCode = null;
  socket.data.playerId = null;

  sendState(room);
}

// בחירת התור הבא.
function nextTurn(room) {
  if (room.status !== "playing") return;

  // לא מעבירים תור כשעדיין ממתינים לתשובה.
  if (hasUnansweredQuestion(room)) {
    sendState(room);
    return;
  }

  const order = room.turnOrder;

  if (!order.length) {
    room.currentTurnId = null;
    sendState(room);
    return;
  }

  // מחפשים את השחקן הבא שיכול לבצע פעולה.
  for (let i = 0; i < order.length; i++) {
    room.turnIndex++;

    if (room.turnIndex >= order.length) {
      room.turnIndex = 0;
      room.round++;
    }

    const candidateId = order[room.turnIndex];
    const candidate = room.players.get(candidateId);

    if (!candidate || !candidate.connected || !candidate.inGame) {
      continue;
    }

    const hasAvailableTarget = activePlayers(room).some(target =>
      canAskAbout(room, candidate, target.id)
    );

    if (hasAvailableTarget) {
      room.currentTurnId = candidate.id;
      sendState(room);
      return;
    }
  }

  // אין כרגע שחקן מחובר שיכול לשחק.
  // נשאיר את התור ריק וננסה שוב כשמישהו יתחבר.
  room.currentTurnId = null;
  sendState(room);
}

function finishGame(room, reason) {
  if (!room || room.status === "finished") return;

  room.status = "finished";
  room.currentTurnId = null;
  room.finishedReason = reason;

  for (const player of activePlayers(room)) {
    player.revealStep = 0;
  }

  notifyRoom(
    room,
    reason === "time"
      ? "הזמן נגמר! המשחק הסתיים."
      : "כל אפשרויות הניחוש נוצלו! המשחק הסתיים.",
    "success"
  );

  sendState(room);
}

function startNewGameWithSamePlayers(room) {
  room.status = "lobby";
  room.replayMode = true;

  room.messages = [];
  room.questionHistory = [];

  room.turnOrder = [];
  room.turnIndex = -1;
  room.currentTurnId = null;
  room.round = 0;

  room.deadline = null;

  room.guessLog = [];
  room.finishedReason = null;

  for (const player of room.players.values()) {
    resetPlayerForNewGame(player);
  }

  notifyRoom(
    room,
    "המנהל פתח משחק חדש! האם תרצה להשתתף שוב?",
    "info"
  );

  sendState(room);
}

io.on("connection", socket => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  // יצירת חדר חדש.
  socket.on("createRoom", (data = {}, callback = () => {}) => {
    const alias = clean(data.alias, 24);
    const realName = clean(data.realName, 48);
    const browserId = clean(data.browserId, 80);

    if (!alias || !realName || !browserId) {
      return callback({
        error: "צריך למלא שם, זהות סודית ומזהה דפדפן."
      });
    }

    removeSocketFromCurrentRoom(socket);

    const code = makeRoomCode();
    const player = createPlayer(browserId, alias, realName);

    const room = {
      code,
      hostId: player.id,
      status: "lobby",
      replayMode: false,

      players: new Map([[player.id, player]]),

      messages: [],
      questionHistory: [],

      turnOrder: [],
      turnIndex: -1,
      currentTurnId: null,
      round: 0,

      deadline: null,

      guessLog: [],
      finishedReason: null
    };

    rooms.set(code, room);

    attachPlayer(socket, room, player);

    callback({ ok: true, code });
    sendState(room);
  });

  // הצטרפות לחדר.
  socket.on("joinRoom", (data = {}, callback = () => {}) => {
    const code = clean(data.code, 5).toUpperCase();
    const alias = clean(data.alias, 24);
    const realName = clean(data.realName, 48);
    const browserId = clean(data.browserId, 80);

    const room = rooms.get(code);

    if (!room) {
      return callback({ error: "לא נמצא חדר עם הקוד הזה." });
    }

    if (!alias || !realName || !browserId) {
      return callback({ error: "צריך למלא את כל הפרטים." });
    }

    const existingPlayer = room.players.get(browserId);

    if (existingPlayer) {
      removeSocketFromCurrentRoom(socket);
      attachPlayer(socket, room, existingPlayer);

      return callback({
        ok: true,
        code,
        resumed: true
      });
    }

    if (room.status !== "lobby" || room.replayMode) {
      return callback({
        error: "המשחק כבר התחיל או שהחדר נמצא בתהליך משחק חוזר."
      });
    }

    if (room.players.size >= MAX_PLAYERS) {
      return callback({
        error: `החדר מלא. אפשר להכניס עד ${MAX_PLAYERS} שחקנים.`
      });
    }

    const aliasTaken = [...room.players.values()].some(
      p => p.alias.toLowerCase() === alias.toLowerCase()
    );

    if (aliasTaken) {
      return callback({ error: "השם הזה כבר תפוס." });
    }

    removeSocketFromCurrentRoom(socket);

    const player = createPlayer(browserId, alias, realName);
    room.players.set(player.id, player);

    attachPlayer(socket, room, player);

    callback({ ok: true, code });
    sendState(room);
  });

  // חזרה לחדר לאחר רענון או ניתוק.
  socket.on("resumeRoom", (data = {}, callback = () => {}) => {
    const code = clean(data.code, 5).toUpperCase();
    const browserId = clean(data.browserId, 80);

    const room = rooms.get(code);
    const player = room?.players.get(browserId);

    if (!room || !player) {
      return callback({
        error: "לא נמצאו פרטי משחק קודמים בדפדפן הזה."
      });
    }

    removeSocketFromCurrentRoom(socket);
    attachPlayer(socket, room, player);

    callback({ ok: true, code });
  });

  // תשובה להזמנה למשחק חוזר.
  socket.on("answerReplayInvite", (data = {}, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || !room.replayMode || room.status !== "lobby") {
      return callback({ error: "אין הזמנה פעילה למשחק חוזר." });
    }

    if (player.replayStatus !== "pending") {
      return callback({ error: "כבר ענית להזמנה הזאת." });
    }

    if (data.answer === "yes") {
      player.replayStatus = "accepted";
      player.inGame = true;
      player.replayPrompt = false;

      notifyRoom(
        room,
        `${player.alias} הצטרף למשחק החדש.`,
        "info"
      );

      sendState(room);
      return callback({ ok: true, accepted: true });
    }

    if (data.answer === "no") {
      player.replayStatus = "declined";
      player.inGame = false;
      player.replayPrompt = false;

      notifyRoom(
        room,
        `${player.alias} לא משתתף במשחק החדש.`,
        "info"
      );

      sendState(room);
      return callback({ ok: true, accepted: false });
    }

    callback({ error: "תשובה לא תקינה." });
  });

  // בחירת זהות חדשה.
  socket.on("setNewIdentity", (data = {}, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);
    const realName = clean(data.realName, 48);

    if (!room || !player) {
      return callback({ error: "אין חדר פעיל." });
    }

    if (room.status !== "lobby" || !room.replayMode) {
      return callback({ error: "אין כרגע אפשרות לבחור זהות חדשה." });
    }

    if (!player.inGame || player.replayStatus !== "accepted") {
      return callback({ error: "לא אישרת השתתפות במשחק החדש." });
    }

    if (!realName) {
      return callback({ error: "צריך לכתוב שם אישיות." });
    }

    player.realName = realName;

    sendState(room);
    callback({ ok: true });
  });

  // פתיחת משחק חדש עם אותם משתתפים.
  socket.on("newGameSamePlayers", (callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player) {
      return callback({ error: "אין חדר פעיל." });
    }

    if (room.status !== "finished") {
      return callback({ error: "אפשר לפתוח משחק חדש רק אחרי סיום המשחק." });
    }

    if (room.hostId !== player.id) {
      return callback({ error: "רק מנהל החדר יכול לפתוח משחק חדש." });
    }

    startNewGameWithSamePlayers(room);
    callback({ ok: true });
  });

  // התחלת משחק.
  socket.on("startGame", (callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player) {
      return callback?.({ error: "אין חדר פעיל." });
    }

    if (room.hostId !== player.id) {
      return callback?.({ error: "רק מנהל החדר יכול להתחיל." });
    }

    if (room.status !== "lobby") {
      return callback?.({ error: "המשחק כבר התחיל." });
    }

    const players = activePlayers(room);

    if (players.length < 2) {
      return callback?.({
        error: "צריך לפחות שני שחקנים שהצטרפו למשחק."
      });
    }

    if (players.some(p => !p.realName)) {
      return callback?.({
        error: "כל המשתתפים צריכים לבחור זהות סודית לפני שמתחילים."
      });
    }

    if (room.replayMode) {
      const unanswered = [...room.players.values()].some(
        p => p.replayStatus === "pending"
      );

      if (unanswered) {
        return callback?.({
          error: "צריך להמתין שכל השחקנים יענו להזמנה."
        });
      }
    }

    room.status = "playing";
    room.replayMode = false;
    room.deadline = Date.now() + GAME_LENGTH_SECONDS * 1000;

    room.turnOrder = players
      .map(p => p.id)
      .sort(() => Math.random() - 0.5);

    room.turnIndex = -1;
    room.round = 1;
    room.currentTurnId = null;

    notifyRoom(room, "המשחק התחיל! בהצלחה לכולם.", "success");

    nextTurn(room);
    callback?.({ ok: true });
  });

  // שליחת שאלה בתור.
  socket.on("askQuestion", (data = {}, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || room.status !== "playing") {
      return callback({ error: "אין משחק פעיל." });
    }

    const target = room.players.get(data.targetId);
    const questionText = clean(data.question, 240);

    if (!target || !target.inGame) {
      return callback({ error: "השחקן שנבחר לא נמצא במשחק." });
    }

    if (room.currentTurnId !== player.id) {
      return callback({ error: "זה לא התור שלך." });
    }

    if (target.id === player.id) {
      return callback({ error: "אי אפשר לשאול את עצמך." });
    }

    if (!canAskAbout(room, player, target.id)) {
      return callback({ error: "כבר אי אפשר לשאול את השחקן הזה." });
    }

    if (!questionText) {
      return callback({ error: "צריך לכתוב שאלה." });
    }

    // מונע פתיחת כמה שאלות לפני שהקודמת נענתה.
    if (hasUnansweredQuestion(room)) {
      return callback({
        error: "צריך להמתין לתשובה על השאלה הקודמת."
      });
    }

    const question = {
      id: createId(),

      fromId: player.id,
      fromAlias: player.alias,

      toId: target.id,
      toAlias: target.alias,

      text: questionText,

      answer: null,
      time: Date.now(),
      answeredAt: null
    };

    target.questions.unshift(question);
    target.pendingQuestion = question;
    room.questionHistory.unshift(question);

    notifyRoom(
      room,
      `${player.alias} שאל את ${target.alias}: "${questionText}"`,
      "question"
    );

    // התור נשאר אצל השואל עד שהנשאל עונה.
    sendState(room);
    callback({ ok: true });
  });

  // תשובה לשאלה שהתקבלה.
  socket.on("answerQuestion", (data = {}, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || room.status !== "playing") {
      return callback({ error: "אין משחק פעיל." });
    }

    const question = player.pendingQuestion;

    if (!question || question.id !== data.questionId) {
      return callback({ error: "השאלה כבר לא ממתינה לתשובה." });
    }

    if (data.answer !== "yes" && data.answer !== "no") {
      return callback({ error: "התשובה אינה תקינה." });
    }

    question.answer = data.answer;
    question.answeredAt = Date.now();

    if (data.answer === "yes") {
      player.knownDetails.unshift(question.text);
    }

    notifyRoom(
      room,
      `${player.alias} ענה ${
        data.answer === "yes" ? "כן" : "לא"
      } לשאלה של ${question.fromAlias}.`,
      data.answer === "yes" ? "success" : "info"
    );

    player.pendingQuestion = null;

    sendState(room);
    callback({ ok: true });

    // רק עכשיו עוברים לשחקן הבא.
    nextTurn(room);
  });

  // צ'אט ציבורי – רק הודעות שהשחקנים כותבים בעצמם.
  socket.on("chat", (data = {}, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || room.status !== "playing" || !player.inGame) {
      return callback?.({
        error: "אפשר להשתמש בצ'אט בזמן משחק בלבד."
      });
    }

    const message = clean(data.text, 240);

    if (!message) {
      return callback?.({ error: "ההודעה ריקה." });
    }

    addChatMessage(room, message, player.alias);

    sendState(room);
    callback?.({ ok: true });
  });

  // ניחוש זהות.
  socket.on("guess", (data = {}, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || room.status !== "playing" || !player.inGame) {
      return callback({ error: "אין משחק פעיל." });
    }

    if (room.currentTurnId !== player.id) {
      return callback({ error: "זה לא התור שלך." });
    }

    if (hasUnansweredQuestion(room)) {
      return callback({
        error: "צריך להמתין לתשובה על השאלה הפתוחה לפני שמנחשים."
      });
    }

    const target = room.players.get(data.targetId);
    const guessText = clean(data.realNameGuess, 48);

    if (!target || !target.inGame) {
      return callback({ error: "השחקן לא נמצא במשחק." });
    }

    if (target.id === player.id) {
      return callback({ error: "אי אפשר לנחש את עצמך." });
    }

    if (!canAskAbout(room, player, target.id)) {
      return callback({
        error: "ניצלת את אפשרויות הניחוש שלך על השחקן הזה."
      });
    }

    if (!guessText) {
      return callback({ error: "צריך לכתוב ניחוש." });
    }

    const attemptNumber =
      (player.attempts.get(target.id) || 0) + 1;

    player.attempts.set(target.id, attemptNumber);

    const correct = isCorrectGuess(guessText, target.realName);

    const secondsLeft = remainingSeconds(room);
    const points = correct ? calculatePoints(room) : 0;

    if (correct) {
      player.correctTargets.add(target.id);
      player.score += points;
    }

    const record = {
      id: createId(),

      guesserId: player.id,
      guesserAlias: player.alias,

      targetId: target.id,
      targetAlias: target.alias,

      guess: guessText,
      correct,

      points,
      timeLeft: formatTime(secondsLeft),
      secondsLeft,

      attemptNumber
    };

    room.guessLog.push(record);

    notifyRoom(
      room,
      correct
        ? `${player.alias} הצליח לנחש את ${target.alias}! (+${points} נקודות)`
        : `${player.alias} ניסה לנחש את ${target.alias}, אך הניחוש לא הצליח.`,
      correct ? "success" : "info"
    );

    const attemptsLeft = 2 - attemptNumber;

    if (!hasAnyGuessOpportunity(room)) {
      finishGame(room, "guesses");
    } else {
      // אחרי ניחוש, נכון או לא נכון, עוברים לשחקן הבא.
      nextTurn(room);
    }

    callback({
      ok: true,
      correct,
      points,
      attemptsLeft
    });
  });

  // מעבר אישי בין שלבי החשיפה.
  socket.on("revealNext", (callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || room.status !== "finished" || !player.inGame) {
      return callback?.({
        error: "שלב החשיפה עדיין לא זמין."
      });
    }

    const maximumStep = room.guessLog.length + 1;

    if (player.revealStep < maximumStep) {
      player.revealStep++;
    }

    sendState(room);

    callback?.({ ok: true });
  });

  // ניתוק.
  socket.on("disconnect", () => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player) return;

    player.sockets.delete(socket.id);
    player.connected = player.sockets.size > 0;

    if (
      room.hostId === player.id &&
      !player.connected
    ) {
      const nextHost = [...room.players.values()].find(
        p => p.connected
      );

      if (nextHost) room.hostId = nextHost.id;
    }

    if (
      room.status === "playing" &&
      room.currentTurnId === player.id &&
      !player.connected
    ) {
      nextTurn(room);
    }

    sendState(room);
  });
});

// עדכון הטיימר וסיום אוטומטי.
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

server.listen(PORT, () => {
  console.log(`Identity Mystery is running at http://localhost:${PORT}`);
});
