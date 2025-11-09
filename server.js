const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

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

// Agora Token Generation Endpoint
app.post('/api/generate-token', (req, res) => {
  try {
    const { channelName, uid } = req.body;
    
    // Validate required environment variables
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || !appCertificate) {
      return res.status(500).json({
        error: 'Server configuration error: Agora credentials not set',
        code: 'CONFIG_ERROR'
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
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid || 0,
      RtcRole.PUBLISHER,
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
      code: 'TOKEN_GENERATION_ERROR'
    });
  }
});

// Get server configuration (for debugging)
app.get('/api/config', (req, res) => {
  res.json({
    agoraAppId: process.env.AGORA_APP_ID ? 'Configured' : 'Not configured',
    agoraCertificate: process.env.AGORA_APP_CERTIFICATE ? 'Configured' : 'Not configured',
    clientUrl: process.env.CLIENT_URL || 'Not configured',
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 5000
  });
});

// Room management endpoints
app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    roomId,
    userCount: room.users.size,
    videoUserCount: room.videoUsers.size,
    created: room.created,
    owner: room.owner
  });
});

app.delete('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  
  if (rooms.has(roomId)) {
    rooms.delete(roomId);
    res.json({ message: 'Room deleted successfully' });
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id, "Environment:", process.env.NODE_ENV);

  // Join room functionality
  socket.on("join-room", ({ roomId, username, isOwner = false }) => {
    try {
      // Validate input
      if (!roomId || !username) {
        socket.emit("error", { message: "Room ID and username are required" });
        return;
      }

      // Leave previous room if any
      if (socket.roomId) {
        socket.leave(socket.roomId);
      }

      socket.join(roomId);
      socket.roomId = roomId;
      socket.username = username;

      // Initialize room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          nodes: [],
          edges: [],
          users: new Map(),
          owner: socket.id, // First user to join becomes owner
          videoUsers: new Map(),
          created: new Date(),
          settings: {
            maxUsers: parseInt(process.env.MAX_USERS_PER_ROOM) || 50,
            allowScreenShare: true,
            allowRecording: true
          }
        });
      }

      const room = rooms.get(roomId);
      
      // Check room capacity
      if (room.users.size >= room.settings.maxUsers) {
        socket.emit("error", { message: "Room is full" });
        return;
      }
      
      // Add user to room
      room.users.set(socket.id, {
        id: socket.id,
        username,
        joinedAt: new Date(),
        isOwner: isOwner || room.owner === socket.id,
        videoEnabled: true,
        audioEnabled: true,
        lastSeen: new Date()
      });

      console.log(`${username} joined room ${roomId} as ${room.owner === socket.id ? 'owner' : 'participant'}`);
      
      // Send current room state to the new user
      socket.emit("room-state", {
        nodes: room.nodes,
        edges: room.edges,
        users: Array.from(room.users.values()),
        isOwner: room.owner === socket.id,
        roomSettings: room.settings
      });

      // Notify others in the room
      socket.to(roomId).emit("user-joined", {
        username,
        socketId: socket.id,
        users: Array.from(room.users.values())
      });

      // Broadcast updated user list
      io.to(roomId).emit("users-updated", Array.from(room.users.values()));
    } catch (error) {
      console.error("Error in join-room:", error);
      socket.emit("error", { message: "Failed to join room", details: error.message });
    }
  });

  // Join video room specifically
  socket.on("join-video-room", ({ roomId, username, isOwner = false }) => {
    try {
      socket.join(roomId);
      socket.roomId = roomId;
      socket.username = username;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          nodes: [],
          edges: [],
          users: new Map(),
          videoUsers: new Map(),
          owner: socket.id,
          created: new Date(),
          settings: {
            maxUsers: parseInt(process.env.MAX_USERS_PER_ROOM) || 50,
            allowScreenShare: true,
            allowRecording: true
          }
        });
      }

      const room = rooms.get(roomId);
      
      // Check video room capacity
      if (room.videoUsers.size >= room.settings.maxUsers) {
        socket.emit("error", { message: "Video room is full" });
        return;
      }
      
      // Add to video users
      room.videoUsers.set(socket.id, {
        id: socket.id,
        username,
        isOwner: isOwner || room.owner === socket.id,
        videoEnabled: true,
        audioEnabled: true,
        joinedAt: new Date(),
        lastSeen: new Date()
      });

      console.log(`${username} joined video room ${roomId}`);

      // Send current video room state
      socket.emit("video-room-state", {
        users: Array.from(room.videoUsers.values()),
        isOwner: room.owner === socket.id
      });

      // Notify others in the video room
      socket.to(roomId).emit("video-user-joined", {
        user: { 
          id: socket.id, 
          username, 
          isOwner: room.owner === socket.id,
          videoEnabled: true,
          audioEnabled: true
        },
        users: Array.from(room.videoUsers.values())
      });
    } catch (error) {
      console.error("Error in join-video-room:", error);
      socket.emit("error", { message: "Failed to join video room", details: error.message });
    }
  });

  // WebRTC Signaling
  socket.on("offer", (data) => {
    socket.to(data.target).emit("offer", {
      offer: data.offer,
      sender: socket.id,
      username: socket.username
    });
  });

  socket.on("answer", (data) => {
    socket.to(data.target).emit("answer", {
      answer: data.answer,
      sender: socket.id,
      username: socket.username
    });
  });

  socket.on("ice-candidate", (data) => {
    socket.to(data.target).emit("ice-candidate", {
      candidate: data.candidate,
      sender: socket.id,
      username: socket.username
    });
  });

  // Media control events
  socket.on("media-toggle", (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      const user = room.videoUsers.get(socket.id);
      
      if (user) {
        if (data.video !== undefined) user.videoEnabled = data.video;
        if (data.audio !== undefined) user.audioEnabled = data.audio;

        socket.to(socket.roomId).emit("user-media-update", {
          userId: socket.id,
          video: user.videoEnabled,
          audio: user.audioEnabled,
          username: user.username
        });
      }
    }
  });

  // Screen sharing
  socket.on("start-screen-share", (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit("screen-share-started", {
        userId: socket.id,
        username: socket.username
      });
    }
  });

  socket.on("stop-screen-share", (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit("screen-share-stopped", {
        userId: socket.id
      });
    }
  });

  // Chat messages
  socket.on("send-message", (data) => {
    if (socket.roomId) {
      const message = {
        id: Date.now().toString(),
        user: socket.username,
        userId: socket.id,
        text: data.text,
        timestamp: new Date()
      };
      
      io.to(socket.roomId).emit("new-message", message);
    }
  });

  // Recording controls (owner only)
  socket.on("start-recording", (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      if (room.owner === socket.id && room.settings.allowRecording) {
        io.to(socket.roomId).emit("recording-started", {
          startedBy: socket.username
        });
      }
    }
  });

  socket.on("stop-recording", (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      if (room.owner === socket.id) {
        io.to(socket.roomId).emit("recording-stopped");
      }
    }
  });

  // Handle diagram updates
  socket.on("update-diagram", (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      
      // Update room state
      room.nodes = data.nodes || room.nodes;
      room.edges = data.edges || room.edges;
      
      // Broadcast to all other users in the room
      socket.to(socket.roomId).emit("update-diagram", data);
    }
  });

  // Handle drawing events
  socket.on("draw", (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit("draw", data);
    }
  });

  socket.on("clear", () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit("clear");
    }
  });

  // Handle room ownership transfer
  socket.on("transfer-ownership", (newOwnerId) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      if (room.owner === socket.id) {
        room.owner = newOwnerId;
        
        // Update owner status for all users
        room.users.forEach((user, userId) => {
          user.isOwner = userId === newOwnerId;
        });

        room.videoUsers.forEach((user, userId) => {
          user.isOwner = userId === newOwnerId;
        });
        
        io.to(socket.roomId).emit("ownership-transferred", {
          newOwnerId,
          users: Array.from(room.users.values())
        });
      }
    }
  });

  // Leave video room
  socket.on("leave-video-room", () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      room.videoUsers.delete(socket.id);

      socket.to(socket.roomId).emit("video-user-left", {
        userId: socket.id,
        users: Array.from(room.videoUsers.values())
      });
    }
  });

  // Leave room completely
  socket.on("leave-room", () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      
      // Remove from both user maps
      room.users.delete(socket.id);
      room.videoUsers.delete(socket.id);

      // If owner disconnected and there are other users, transfer ownership
      if (room.owner === socket.id && room.users.size > 0) {
        const newOwner = Array.from(room.users.keys())[0];
        room.owner = newOwner;
        
        // Update owner status
        room.users.forEach((user, userId) => {
          user.isOwner = userId === newOwner;
        });

        room.videoUsers.forEach((user, userId) => {
          user.isOwner = userId === newOwner;
        });
        
        io.to(socket.roomId).emit("ownership-transferred", {
          newOwnerId: newOwner,
          users: Array.from(room.users.values())
        });
      }

      // If room is empty, clean it up
      if (room.users.size === 0) {
        rooms.delete(socket.roomId);
        console.log(`Room ${socket.roomId} deleted (empty)`);
      } else {
        // Notify remaining users about user leaving
        socket.to(socket.roomId).emit("user-left", {
          socketId: socket.id,
          username: socket.username,
          users: Array.from(room.users.values())
        });

        // Notify about video user leaving
        socket.to(socket.roomId).emit("video-user-left", {
          userId: socket.id,
          users: Array.from(room.videoUsers.values())
        });
        
        // Broadcast updated user list
        io.to(socket.roomId).emit("users-updated", Array.from(room.users.values()));
      }
    }
  });

  // Handle disconnect
  socket.on("disconnect", (reason) => {
    console.log("User disconnected:", socket.id, socket.username, "Reason:", reason);
    
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      
      // Remove from both user maps
      room.users.delete(socket.id);
      room.videoUsers.delete(socket.id);

      // If owner disconnected and there are other users, transfer ownership
      if (room.owner === socket.id && room.users.size > 0) {
        const newOwner = Array.from(room.users.keys())[0];
        room.owner = newOwner;
        
        // Update owner status
        room.users.forEach((user, userId) => {
          user.isOwner = userId === newOwner;
        });

        room.videoUsers.forEach((user, userId) => {
          user.isOwner = userId === newOwner;
        });
        
        io.to(socket.roomId).emit("ownership-transferred", {
          newOwnerId: newOwner,
          users: Array.from(room.users.values())
        });
      }

      // If room is empty, clean it up
      if (room.users.size === 0) {
        rooms.delete(socket.roomId);
        console.log(`Room ${socket.roomId} deleted (empty)`);
      } else {
        // Notify remaining users about user leaving
        socket.to(socket.roomId).emit("user-left", {
          socketId: socket.id,
          username: socket.username,
          users: Array.from(room.users.values())
        });

        // Notify about video user leaving
        socket.to(socket.roomId).emit("video-user-left", {
          userId: socket.id,
          users: Array.from(room.videoUsers.values())
        });
        
        // Broadcast updated user list
        io.to(socket.roomId).emit("users-updated", Array.from(room.users.values()));
      }
    }
  });

  // Error handling
  socket.on("error", (error) => {
    console.error("Socket error:", socket.id, error);
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    rooms: rooms.size,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
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