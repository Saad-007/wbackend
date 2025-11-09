const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// Load environment variables
require('dotenv').config();

const app = express();
const server = createServer(app);

// CORS configuration for production
const corsOptions = {
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// Socket.io configuration with production settings
const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8 // 100MB max buffer size for file sharing
});

// Store room data
const rooms = new Map();

// Agora Token Generation Endpoint (with error handling)
app.post('/api/generate-token', (req, res) => {
  try {
    const { channelName, uid } = req.body;
    
    // Check if agora-access-token is available
    let agoraTokenBuilder;
    try {
      agoraTokenBuilder = require('agora-access-token');
    } catch (agoraError) {
      console.warn('Agora token module not available, using fallback');
      return res.status(503).json({
        error: 'Token service temporarily unavailable',
        code: 'SERVICE_UNAVAILABLE',
        useFallback: true
      });
    }
    
    // Validate required environment variables
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || !appCertificate) {
      return res.status(500).json({
        error: 'Server configuration error: Agora credentials not set',
        code: 'CONFIG_ERROR',
        useFallback: true
      });
    }

    if (!channelName) {
      return res.status(400).json({
        error: 'Channel name is required',
        code: 'MISSING_CHANNEL'
      });
    }

    // Set token expiration time (1 hour)
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    // Build token with user role
    const token = agoraTokenBuilder.RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid || 0,
      agoraTokenBuilder.RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    res.json({
      token: token,
      appId: appId,
      channelName: channelName,
      uid: uid || 0,
      expiration: privilegeExpiredTs
    });

  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({
      error: 'Failed to generate token',
      details: error.message,
      code: 'TOKEN_GENERATION_ERROR',
      useFallback: true
    });
  }
});

// Get server configuration (for debugging)
app.get('/api/config', (req, res) => {
  let agoraAvailable = false;
  try {
    require('agora-access-token');
    agoraAvailable = true;
  } catch (e) {
    agoraAvailable = false;
  }
  
  res.json({
    agoraAppId: process.env.AGORA_APP_ID ? 'Configured' : 'Not configured',
    agoraCertificate: process.env.AGORA_APP_CERTIFICATE ? 'Configured' : 'Not configured',
    agoraModuleAvailable: agoraAvailable,
    clientUrl: process.env.CLIENT_URL || 'Not configured',
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 5000
  });
});

// ... (rest of your existing socket.io code remains exactly the same)
// Room management endpoints, socket events, etc.

// Health check endpoint
app.get("/health", (req, res) => {
  let agoraAvailable = false;
  try {
    require('agora-access-token');
    agoraAvailable = true;
  } catch (e) {
    agoraAvailable = false;
  }
  
  res.json({ 
    status: "ok", 
    rooms: rooms.size,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0',
    agoraAvailable: agoraAvailable
  });
});

// Get room statistics
app.get("/stats", (req, res) => {
  const stats = {
    totalRooms: rooms.size,
    totalUsers: Array.from(rooms.values()).reduce((sum, room) => sum + room.users.size, 0),
    totalVideoUsers: Array.from(rooms.values()).reduce((sum, room) => sum + room.videoUsers.size, 0),
    rooms: Array.from(rooms.entries()).map(([roomId, room]) => ({
      roomId,
      userCount: room.users.size,
      videoUserCount: room.videoUsers.size,
      owner: room.owner,
      created: room.created,
      ageMinutes: Math.floor((new Date() - room.created) / (1000 * 60))
    }))
  };
  res.json(stats);
});

// Clean up old rooms (run every hour)
setInterval(() => {
  const now = new Date();
  const MAX_ROOM_AGE = 24 * 60 * 60 * 1000; // 24 hours
  
  let cleanedCount = 0;
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.created > MAX_ROOM_AGE && room.users.size === 0) {
      rooms.delete(roomId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`Cleaned up ${cleanedCount} old rooms`);
  }
}, 60 * 60 * 1000); // Run every hour

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Agora App ID: ${process.env.AGORA_APP_ID ? 'Configured' : 'Not configured'}`);
  console.log(`🔗 Client URL: ${process.env.CLIENT_URL || 'Not configured'}`);
  
  // Check if agora module is available
  try {
    require('agora-access-token');
    console.log(`✅ Agora token module: Available`);
  } catch (e) {
    console.log(`⚠️ Agora token module: Not available - token generation will fail`);
  }
  
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Statistics: http://localhost:${PORT}/stats`);
  console.log(`⚙️ Config: http://localhost:${PORT}/api/config`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});