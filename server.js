const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function clean(value, max = 32) {
  return String(value ?? "").trim().replace(/[<>]/g, "").slice(0, max);
}

function getRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      alias: p.alias,
      connected: p.connected,
      score: p.score
    })),
    messages: room.messages.slice(-60),
    reveal: room.status === "finished"
      ? [...room.players.values()].map(p => ({
          alias: p.alias,
          realName: p.realName,
          score: p.score
        }))
      : null
  };
}

function sendState(room) {
  io.to(room.code).emit("state", publicState(room));
}

function leaveCurrentRoom(socket) {
  const room = getRoom(socket);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.code);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }
  sendState(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ realName, alias }, callback) => {
    realName = clean(realName, 32);
    alias = clean(alias, 24);
    if (!realName || !alias) return callback({ error: "צריך למלא שם אמיתי ושם בדוי." });

    leaveCurrentRoom(socket);
    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      status: "lobby",
      players: new Map(),
      messages: []
    };
    room.players.set(socket.id, {
      id: socket.id,
      realName,
      alias,
      connected: true,
      score: 0,
      guessed: new Set()
    });
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    callback({ ok: true, code });
    sendState(room);
  });

  socket.on("joinRoom", ({ code, realName, alias }, callback) => {
    code = clean(code, 5).toUpperCase();
    realName = clean(realName, 32);
    alias = clean(alias, 24);
    const room = rooms.get(code);

    if (!realName || !alias) return callback({ error: "צריך למלא שם אמיתי ושם בדוי." });
    if (!room) return callback({ error: "לא מצאתי חדר עם הקוד הזה." });
    if (room.status !== "lobby") return callback({ error: "המשחק כבר התחיל." });
    if (room.players.size >= 20) return callback({ error: "החדר מלא (עד 20 שחקנים)." });

    const aliasTaken = [...room.players.values()].some(
      p => p.alias.toLowerCase() === alias.toLowerCase()
    );
    if (aliasTaken) return callback({ error: "השם הבדוי הזה כבר תפוס. בחר שם אחר." });

    leaveCurrentRoom(socket);
    room.players.set(socket.id, {
      id: socket.id,
      realName,
      alias,
      connected: true,
      score: 0,
      guessed: new Set()
    });
    socket.data.roomCode = code;
    socket.join(code);
    callback({ ok: true, code });
    sendState(room);
  });

  socket.on("startGame", callback => {
    const room = getRoom(socket);
    if (!room) return callback?.({ error: "אין חדר פעיל." });
    if (room.hostId !== socket.id) return callback?.({ error: "רק מנהל החדר יכול להתחיל." });
    if (room.players.size < 2) return callback?.({ error: "צריך לפחות שני שחקנים." });
    room.status = "playing";
    room.messages.push({
      system: true,
      text: "המשחק התחיל! נסו לגלות מי מסתתר מאחורי כל שם."
    });
    sendState(room);
    callback?.({ ok: true });
  });

  socket.on("chat", ({ text }, callback) => {
    const room = getRoom(socket);
    const player = room?.players.get(socket.id);
    text = clean(text, 240);
    if (!room || !player || room.status !== "playing") {
      return callback?.({ error: "אי אפשר לשלוח הודעה כרגע." });
    }
    if (!text) return;
    room.messages.push({
      system: false,
      alias: player.alias,
      text,
      time: Date.now()
    });
    room.messages = room.messages.slice(-100);
    sendState(room);
    callback?.({ ok: true });
  });

  socket.on("guess", ({ targetId, realNameGuess }, callback) => {
    const room = getRoom(socket);
    const player = room?.players.get(socket.id);
    const target = room?.players.get(targetId);
    realNameGuess = clean(realNameGuess, 32);

    if (!room || room.status !== "playing" || !player || !target) {
      return callback?.({ error: "הניחוש לא זמין כרגע." });
    }
    if (target.id === player.id) return callback?.({ error: "אי אפשר לנחש את עצמך." });
    if (player.guessed.has(target.id)) {
      return callback?.({ error: "כבר ניחשת את השחקן הזה." });
    }
    if (!realNameGuess) return callback?.({ error: "כתוב שם לניחוש." });

    player.guessed.add(target.id);
    const correct = realNameGuess.localeCompare(target.realName, "he", {
      sensitivity: "base"
    }) === 0;

    if (correct) {
      player.score += 10;
      room.messages.push({
        system: true,
        text: `${player.alias} גילה נכון את הזהות של ${target.alias}! (+10 נקודות)`
      });
    } else {
      player.score = Math.max(0, player.score - 2);
      room.messages.push({
        system: true,
        text: `${player.alias} ניסה לנחש את ${target.alias}, אבל לא הצליח. (-2 נקודות)`
      });
    }
    sendState(room);
    callback?.({ ok: true, correct });
  });

  socket.on("reveal", callback => {
    const room = getRoom(socket);
    if (!room) return callback?.({ error: "אין חדר פעיל." });
    if (room.hostId !== socket.id) return callback?.({ error: "רק מנהל החדר יכול לחשוף." });
    room.status = "finished";
    room.messages.push({ system: true, text: "המשחק הסתיים! כל הזהויות נחשפו." });
    sendState(room);
    callback?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.connected = false;
    // Keep the player and their secret identity until the room is finished.
    if (room.hostId === socket.id) {
      const next = [...room.players.values()].find(p => p.connected);
      if (next) room.hostId = next.id;
    }
    sendState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Identity Mystery is running on http://localhost:${PORT}`);
});
