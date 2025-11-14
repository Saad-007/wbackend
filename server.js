// ---------------------------------------------
// SERVER.JS — FULL CLEAN WORKING VERSION
// ---------------------------------------------

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { RtcTokenBuilder, RtcRole } = require("agora-token");
require("dotenv").config();

const app = express();
const server = createServer(app);

// ---------------------------------------------
// CORS CONFIG
// ---------------------------------------------
const corsOptions = {
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  methods: ["GET", "POST"],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// ---------------------------------------------
// SOCKET.IO SETUP
// ---------------------------------------------
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Room store
const rooms = new Map();

// ---------------------------------------------
// AGORA TOKEN ENDPOINT (100% FIXED)
// ---------------------------------------------
app.post("/api/generate-token", (req, res) => {
  try {
    const { channelName, uid } = req.body;

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.status(500).json({
        error: "Agora App ID or Certificate not set",
        code: "CONFIG_ERROR",
      });
    }

    if (!channelName) {
      return res.status(400).json({
        error: "Channel name required",
        code: "MISSING_CHANNEL",
      });
    }

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      Number(uid) || 0,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    return res.json({
      token,
      appId,
      channelName,
      uid: Number(uid) || 0,
      expiration: privilegeExpiredTs,
    });
  } catch (err) {
    console.error("Token error:", err);
    return res.status(500).json({
      error: "Token generation failed",
      details: err.message,
      code: "TOKEN_ERROR",
    });
  }
});

// ---------------------------------------------
// BACKEND CONFIG (for debugging)
// ---------------------------------------------
app.get("/api/config", (req, res) => {
  res.json({
    agoraAppId: process.env.AGORA_APP_ID ? "Configured" : "Not configured",
    agoraCertificate: process.env.AGORA_APP_CERTIFICATE ? "Configured" : "Not configured",
    agoraModuleAvailable: true,
    clientUrl: process.env.CLIENT_URL || "Not configured",
    nodeEnv: process.env.NODE_ENV || "development",
    port: process.env.PORT || 5000,
  });
});

// ---------------------------------------------
// HEALTH CHECK
// ---------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    agoraAvailable: true,
  });
});

// ---------------------------------------------
// SOCKET.IO EVENTS (FULL ROOM SYSTEM)
// ---------------------------------------------
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  socket.on("join-room", ({ roomId, user }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        users: new Map(),
        videoUsers: new Map(),
        owner: user.id,
        created: new Date(),
      });
    }

    const room = rooms.get(roomId);
    room.users.set(socket.id, user);

    socket.join(roomId);

    io.to(roomId).emit("user-joined", {
      user,
      users: Array.from(room.users.values()),
    });
  });

  socket.on("leave-room", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.users.delete(socket.id);
    room.videoUsers.delete(socket.id);
    socket.leave(roomId);

    io.to(roomId).emit("user-left", socket.id);

    if (room.users.size === 0) rooms.delete(roomId);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        room.videoUsers.delete(socket.id);

        io.to(roomId).emit("user-left", socket.id);

        if (room.users.size === 0) rooms.delete(roomId);
      }
    }
  });
});

// ---------------------------------------------
// SERVER START
// ---------------------------------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`🌍 Client URL: ${process.env.CLIENT_URL}`);
  console.log(`🔧 Agora Token Module Loaded`);
});
