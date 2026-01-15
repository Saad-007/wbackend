// ---------------------------------------------
// SERVER.JS — FINAL COMPLETE VERSION
// Features: File Upload + Background Polling + Realtime + Whisper + Ollama + Room/Drawing
// Supports: Local AI + Deployed AI (HF + OpenAI)
// ---------------------------------------------

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { RtcTokenBuilder, RtcRole } = require("agora-token");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const {
  processMeetingAudio,
  generateMockIntelligence
} = require("./Services/aiService");

const app = express();
const server = createServer(app);

// ---------------------------------------------
// CONFIGURATION
// ---------------------------------------------
const upload = multer({ dest: "uploads/" });
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const resultsStore = new Map(); // persistent job store
const activeSessions = new Map(); // live transcription sessions
const rooms = new Map(); // room management

const USE_LOCAL_AI = process.env.USE_LOCAL_AI === "true";

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      process.env.CLIENT_URL,
      "http://localhost:5173",
      "http://localhost:3000",
      "https://whiteboard-ten-ochre.vercel.app"
    ].filter(Boolean);
    callback(allowedOrigins.includes(origin) ? null : new Error("Not allowed by CORS"), allowedOrigins.includes(origin));
  },
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());

const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000
});

// ---------------------------------------------
// INTELLIGENT SUMMARY (LOCAL OR DEPLOYED)
// ---------------------------------------------
async function summarizeMeeting(transcript) {
  if (!transcript || transcript.length < 50) return null;

  if (USE_LOCAL_AI) {
    // Local Ollama
    try {
      const prompt = `
        Analyze meeting transcript in mixed Urdu/English.
        Preserve all names exactly.
        Output JSON: { summary, decisions[], actions[] }
        Transcript:
        """${transcript}"""
      `;
      const response = await axios.post("http://127.0.0.1:11434/api/generate", {
        model: "mistral",
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.1 }
      });
      const text = response.data.response;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (err) {
      console.error("Ollama Error:", err.message);
      return null;
    }
  } else {
    // Deployed AI (OpenAI)
    try {
      const prompt = `
        You are an expert Project Manager AI.
        Summarize meeting transcript exactly.
        Extract JSON: { summary, decisions[], actions[] }
        Preserve all names, dates, and tasks exactly.
        Transcript:
        ${transcript}
      `;
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4",
          messages: [{ role: "user", content: prompt }]
        },
        { headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}` } }
      );
      const text = response.data.choices[0].message.content;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (err) {
      console.error("OpenAI Error:", err.message);
      return null;
    }
  }
}

// ---------------------------------------------
// DIAGRAM GENERATION ENDPOINT
// ---------------------------------------------
app.post("/api/generate-diagram", async (req, res) => {
  const { summaryText, diagramType } = req.body;
  if (!summaryText) return res.status(400).json({ error: "No text to visualize" });

  try {
    const prompt = `
      You are a Project Manager creating a flowchart from meeting notes.
      TEXT: "${summaryText}"
      Output JSON: { nodes[], edges[] }
    `;

    let aiResponse;
    if (USE_LOCAL_AI) {
      const response = await axios.post("http://127.0.0.1:11434/api/generate", {
        model: "mistral",
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.1 }
      });
      aiResponse = response.data.response;
    } else {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4",
          messages: [{ role: "user", content: prompt }]
        },
        { headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}` } }
      );
      aiResponse = response.data.choices[0].message.content;
    }

    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      res.json({ success: true, data: JSON.parse(jsonMatch[0]) });
    } else {
      res.json({ success: false, message: "AI response was not valid JSON." });
    }
  } catch (err) {
    console.error("Diagram Generation Error:", err.message);
    res.status(500).json({ error: "Failed to generate diagram" });
  }
});

// ---------------------------------------------
// ANALYZE MEETING ENDPOINT (Non-blocking)
// ---------------------------------------------
app.post("/api/analyze-meeting", upload.single("meeting_audio"), async (req, res) => {
  req.setTimeout(0);
  if (!req.file) return res.status(400).json({ error: "No audio file" });

  const roomId = req.body.roomId || `JOB-${Date.now()}`;
  resultsStore.set(roomId, { status: "processing", data: null });
  res.json({ success: true, roomId, message: "Processing started in background" });

  (async () => {
    try {
      console.log(`🎙️ Processing Audio: ${req.file.path}`);
      const aiResults = await processMeetingAudio(req.file.path);
      const transcript = aiResults.transcript;

      console.log(`📝 Transcript Length: ${transcript.length}`);

      if (transcript.length > 50) {
        console.log("🧠 Generating AI Summary...");
        const intelligentData = await summarizeMeeting(transcript);
        if (intelligentData) {
          aiResults.summary = intelligentData.summary;
          aiResults.decisions = intelligentData.decisions;
          aiResults.actions = intelligentData.actions;
        } else {
          console.log("⚠️ Using fallback intelligence");
        }
      }

      resultsStore.set(roomId, { status: "ready", data: aiResults });
      console.log(`✅ Job Finished for ${roomId}`);
    } catch (err) {
      console.error(`❌ Job Failed for ${roomId}:`, err);
      resultsStore.set(roomId, { status: "failed", error: err.message });
    } finally {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
  })();
});

// ---------------------------------------------
// CHECK STATUS ENDPOINT
// ---------------------------------------------
app.get("/api/meeting-result/:roomId", (req, res) => {
  const { roomId } = req.params;
  const result = resultsStore.get(roomId);
  if (!result) return res.status(404).json({ status: "not_found" });
  res.json(result);
});

// ---------------------------------------------
// AGORA TOKEN ENDPOINT
// ---------------------------------------------
app.post("/api/generate-token", (req, res) => {
  try {
    const { channelName, uid } = req.body;
    const token = RtcTokenBuilder.buildTokenWithUid(
      process.env.AGORA_APP_ID,
      process.env.AGORA_APP_CERTIFICATE,
      channelName,
      Number(uid) || 0,
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + 3600
    );
    res.json({ token, appId: process.env.AGORA_APP_ID });
  } catch (err) {
    res.status(500).json({ error: "Token failed" });
  }
});

// ---------------------------------------------
// SOCKET.IO EVENTS
// ---------------------------------------------
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  socket.on("start-transcription-session", () => {
    activeSessions.set(socket.id, { text: "", pending: 0 });
  });

  socket.on("audio-chunk", async (audioBuffer) => {
    const session = activeSessions.get(socket.id);
    if (!session) return;

    session.pending++;
    const tempFile = path.join("uploads", `chunk_${socket.id}_${Date.now()}.webm`);
    try {
      fs.writeFileSync(tempFile, Buffer.from(audioBuffer));
      const result = await processMeetingAudio(tempFile, true);
      if (result?.transcript) {
        session.text += " " + result.transcript.replace(/\s+/g, " ").trim();
        socket.emit("transcript-update", { text: result.transcript, language: result.language });
      }
    } catch (err) {
      console.error("Chunk Error:", err.message);
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      session.pending--;
    }
  });

  socket.on("end-transcription-session", async () => {
    let session = activeSessions.get(socket.id);
    if (!session) return;
    while (session.pending > 0) await new Promise(r => setTimeout(r, 1000));
    const fullText = session.text.trim();
    let intelligence = await summarizeMeeting(fullText);
    if (!intelligence) intelligence = generateMockIntelligence(fullText);
    socket.emit("summary-result", { transcript: fullText, ...intelligence });
    activeSessions.delete(socket.id);
  });

  socket.on("join-room", (data) => {
    if (!rooms.has(data.roomId)) rooms.set(data.roomId, { users: new Map(), owner: data.user.id });
    const room = rooms.get(data.roomId);
    room.users.set(socket.id, { ...data.user, socketId: socket.id });
    socket.join(data.roomId);
    io.to(data.roomId).emit("user-joined", { users: Array.from(room.users.values()) });
  });

  socket.on("leave-room", (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    room.users.delete(socket.id);
    socket.leave(data.roomId);
    io.to(data.roomId).emit("user-left", { socketId: socket.id, users: Array.from(room.users.values()) });
    if (room.users.size === 0) rooms.delete(data.roomId);
  });

  socket.on("drawing", (data) => {
    if (data?.roomId) socket.to(data.roomId).emit("drawing", data);
  });

  socket.on("disconnect", () => {
    activeSessions.delete(socket.id);
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        io.to(roomId).emit("user-left", { socketId: socket.id, users: Array.from(room.users.values()) });
        if (room.users.size === 0) rooms.delete(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log("💡 USE_LOCAL_AI =", USE_LOCAL_AI);
});
