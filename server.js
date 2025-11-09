const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// Store room data
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Join room functionality
  socket.on("join-room", ({ roomId, username, isOwner = false }) => {
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
        created: new Date()
      });
    }

    const room = rooms.get(roomId);
    
    // Add user to room
    room.users.set(socket.id, {
      id: socket.id,
      username,
      joinedAt: new Date(),
      isOwner: isOwner || room.owner === socket.id,
      videoEnabled: true,
      audioEnabled: true
    });

    console.log(`${username} joined room ${roomId} as ${isOwner ? 'owner' : 'participant'}`);
    
    // Send current room state to the new user
    socket.emit("room-state", {
      nodes: room.nodes,
      edges: room.edges,
      users: Array.from(room.users.values()),
      isOwner: room.owner === socket.id
    });

    // Notify others in the room
    socket.to(roomId).emit("user-joined", {
      username,
      socketId: socket.id,
      users: Array.from(room.users.values())
    });

    // Broadcast updated user list
    io.to(roomId).emit("users-updated", Array.from(room.users.values()));
  });

  // Join video room specifically
  socket.on("join-video-room", ({ roomId, username, isOwner = false }) => {
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
        created: new Date()
      });
    }

    const room = rooms.get(roomId);
    
    // Add to video users
    room.videoUsers.set(socket.id, {
      id: socket.id,
      username,
      isOwner: isOwner || room.owner === socket.id,
      videoEnabled: true,
      audioEnabled: true,
      joinedAt: new Date()
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
      if (room.owner === socket.id) {
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
    timestamp: new Date().toISOString()
  });
});

// Get room statistics
app.get("/stats", (req, res) => {
  const stats = {
    totalRooms: rooms.size,
    rooms: Array.from(rooms.entries()).map(([roomId, room]) => ({
      roomId,
      userCount: room.users.size,
      videoUserCount: room.videoUsers.size,
      owner: room.owner,
      created: room.created
    }))
  };
  res.json(stats);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Statistics: http://localhost:${PORT}/stats`);
});