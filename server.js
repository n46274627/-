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

  if (i < a.length || j < b.length) {
    edits++;
  }

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

  // אם הזהות מורכבת משתי מילים, גם מילה אחת יכולה להספיק.
  // מתקבלת גם טעות של אות אחת: הוספה, מחיקה או החלפה.
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

  // לדוגמה: 15:20 = 1520 נקודות.
  return minutes * 100 + rest;
}

function createPlayer(browserId, alias, realName) {
  return {
    id: browserId,
    alias,
    realName,

    connected: true,
    sockets: new Set(),

    score: 0,

    // מספר הניסיונות של השחקן מול כל יעד.
    attempts: new Map(),

    // יעדים שהשחקן כבר ניחש נכון.
    correctTargets: new Set(),

    // שאלות פרטיות שקיבל השחקן.
    questions: [],

    // שאלה שממתינה כרגע לתשובה.
    pendingQuestion: null,

    // כל התשובות החיוביות שקיבל.
    knownDetails: []
  };
}

function canTarget(guesser, targetId) {
  if (!guesser) return false;
  if (guesser.id === targetId) return false;

  if (guesser.correctTargets.has(targetId)) {
    return false;
  }

  const attempts = guesser.attempts.get(targetId) || 0;

  return attempts < 2;
}

function canAskAbout(asker, targetId) {
  return canTarget(asker, targetId);
}

function hasAnyGuessOpportunity(room) {
  const players = [...room.players.values()];

  for (const guesser of players) {
    for (const target of players) {
      if (canTarget(guesser, target.id)) {
        return true;
      }
    }
  }

  return false;
}

function addMessage(room, text, system = true, alias = "") {
  room.messages.push({
    id: createId(),
    text,
    system,
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
    isHost: p.id === room.hostId
  }));

  const attempts = {};
  const blockedTargets = [];

  for (const target of room.players.values()) {
    attempts[target.id] = player.attempts.get(target.id) || 0;

    if (!canTarget(player, target.id)) {
      blockedTargets.push(target.id);
    }
  }

  const finished = room.status === "finished";

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

    // הניחושים נשלחים רק לאחר סיום המשחק.
    guessLog: finished ? room.guessLog : [],

    revealStep: room.revealStep,

    // הזהויות נשלחות רק לאחר שכל הניחושים נחשפו.
    reveal:
      finished && room.revealStep > room.guessLog.length
        ? [...room.players.values()].map(p => ({
            id: p.id,
            alias: p.alias,
            realName: p.realName,
            score: p.score
          }))
        : null,

    finishedReason: room.finishedReason
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

  if (
    room.hostId === player.id &&
    !player.connected
  ) {
    const nextHost = [...room.players.values()].find(p => p.connected);

    if (nextHost) {
      room.hostId = nextHost.id;
    }
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

function nextTurn(room) {
  if (room.status !== "playing") return;

  const order = room.turnOrder;

  if (!order.length) {
    room.currentTurnId = null;
    sendState(room);
    return;
  }

  for (let i = 0; i < order.length; i++) {
    room.turnIndex++;

    if (room.turnIndex >= order.length) {
      room.turnIndex = 0;
      room.round++;
    }

    const candidateId = order[room.turnIndex];
    const candidate = room.players.get(candidateId);

    if (!candidate || !candidate.connected) {
      continue;
    }

    const hasAvailableTarget = [...room.players.values()].some(target =>
      canAskAbout(candidate, target.id)
    );

    if (hasAvailableTarget) {
      room.currentTurnId = candidate.id;
      sendState(room);
      return;
    }
  }

  // אין כרגע שחקן שיכול לשאול שאלה.
  // הניחושים עדיין יכולים להימשך.
  room.currentTurnId = null;
  sendState(room);
}

function finishGame(room, reason) {
  if (!room || room.status === "finished") return;

  room.status = "finished";
  room.currentTurnId = null;
  room.finishedReason = reason;

  // מתחילים את שלב החשיפה מהניחוש הראשון.
  room.revealStep = 0;

  addMessage(
    room,
    reason === "time"
      ? "הזמן נגמר! המשחק הסתיים."
      : "כל אפשרויות הניחוש נוצלו! המשחק הסתיים."
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
        error: "צריך למלא שם בדוי, זהות סודית ומזהה דפדפן."
      });
    }

    removeSocketFromCurrentRoom(socket);

    const code = makeRoomCode();
    const player = createPlayer(browserId, alias, realName);

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

    callback({
      ok: true,
      code
    });

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

    // אם אותו דפדפן כבר נמצא בחדר, משחזרים את השחקן.
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

    if (room.status !== "lobby") {
      return callback({
        error: "המשחק כבר התחיל. אפשר לחזור רק מאותו דפדפן."
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
      return callback({
        error: "השם הבדוי הזה כבר תפוס."
      });
    }

    removeSocketFromCurrentRoom(socket);

    const player = createPlayer(browserId, alias, realName);

    room.players.set(player.id, player);

    attachPlayer(socket, room, player);

    callback({
      ok: true,
      code
    });

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

    callback({
      ok: true,
      code
    });
  });

  // התחלת משחק.
  socket.on("startGame", callback => {
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

    if (room.players.size < 2) {
      return callback?.({ error: "צריך לפחות שני שחקנים." });
    }

    room.status = "playing";
    room.deadline =
      Date.now() + GAME_LENGTH_SECONDS * 1000;

    // סדר תורות אקראי בכל משחק.
    room.turnOrder = [...room.players.keys()].sort(
      () => Math.random() - 0.5
    );

    room.turnIndex = -1;
    room.round = 1;

    addMessage(room, "המשחק התחיל! בהצלחה לכולם.");

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

    if (!target) {
      return callback({ error: "השחקן שנבחר לא נמצא." });
    }

    if (room.currentTurnId !== player.id) {
      return callback({ error: "זה לא התור שלך." });
    }

    if (target.id === player.id) {
      return callback({ error: "אי אפשר לשאול את עצמך." });
    }

    if (!canAskAbout(player, target.id)) {
      return callback({
        error: "כבר אי אפשר לשאול את השחקן הזה."
      });
    }

    if (!questionText) {
      return callback({ error: "צריך לכתוב שאלה." });
    }

    if (player.pendingQuestion) {
      return callback({
        error: "כבר יש שאלה שממתינה לתשובה."
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

    addMessage(
      room,
      `${player.alias} שאל את ${target.alias}: "${questionText}"`
    );

    // השאלה נשלחה והתור הסתיים.
    room.currentTurnId = null;

    sendState(room);

    callback({ ok: true });

    // מעבירים את התור לשחקן הבא.
    setTimeout(() => {
      if (
        room.status === "playing" &&
        room.currentTurnId === null
      ) {
        nextTurn(room);
      }
    }, 300);
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
      return callback({
        error: "השאלה כבר לא ממתינה לתשובה."
      });
    }

    if (data.answer !== "yes" && data.answer !== "no") {
      return callback({ error: "התשובה אינה תקינה." });
    }

    question.answer = data.answer;
    question.answeredAt = Date.now();

    const savedQuestion = player.questions.find(
      q => q.id === question.id
    );

    if (savedQuestion) {
      savedQuestion.answer = data.answer;
      savedQuestion.answeredAt = question.answeredAt;
    }

    if (data.answer === "yes") {
      player.knownDetails.unshift(question.text);
    }

    addMessage(
      room,
      `${player.alias} ענה ${
        data.answer === "yes" ? "כן" : "לא"
      } לשאלה של ${question.fromAlias}: "${question.text}"`
    );

    player.pendingQuestion = null;

    sendState(room);

    callback({ ok: true });
  });

  // צ'אט ציבורי.
  socket.on("chat", (data = {}, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || room.status !== "playing") {
      return callback?.({
        error: "אפשר להשתמש בצ'אט בזמן משחק בלבד."
      });
    }

    const message = clean(data.text, 240);

    if (!message) {
      return callback?.({ error: "ההודעה ריקה." });
    }

    addMessage(room, message, false, player.alias);

    sendState(room);

    callback?.({ ok: true });
  });

  // ניחוש זהות.
  socket.on("guess", (data = {}, callback = () => {}) => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || room.status !== "playing") {
      return callback({ error: "אין משחק פעיל." });
    }

    const target = room.players.get(data.targetId);
    const guessText = clean(data.realNameGuess, 48);

    if (!target) {
      return callback({ error: "השחקן לא נמצא." });
    }

    if (target.id === player.id) {
      return callback({ error: "אי אפשר לנחש את עצמך." });
    }

    if (!canTarget(player, target.id)) {
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

    const correct = isCorrectGuess(
      guessText,
      target.realName
    );

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

    if (correct) {
      addMessage(
        room,
        `${player.alias} הצליח לנחש את ${target.alias}! (+${points} נקודות)`
      );
    } else {
      addMessage(
        room,
        `${player.alias} ניסה לנחש את ${target.alias}, אך הניחוש לא הצליח.`
      );
    }

    const attemptsLeft = 2 - attemptNumber;

    if (!hasAnyGuessOpportunity(room)) {
      finishGame(room, "guesses");
    } else {
      sendState(room);
    }

    callback({
      ok: true,
      correct,
      points,
      attemptsLeft
    });
  });

  // מעבר בין שלבי החשיפה בסוף המשחק.
  socket.on("revealNext", callback => {
    const room = getRoom(socket);
    const player = getPlayer(socket);

    if (!room || !player || room.status !== "finished") {
      return callback?.({
        error: "שלב החשיפה עדיין לא זמין."
      });
    }

    const maximumStep = room.guessLog.length + 1;

    if (room.revealStep < maximumStep) {
      room.revealStep++;
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

      if (nextHost) {
        room.hostId = nextHost.id;
      }
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
