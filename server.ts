import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";

async function startServer() {
  console.log("Starting server...");
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  const PORT = 3000;

  // Initialize Firebase Admin
  const firebaseConfig = JSON.parse(readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8'));
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
  console.log("Firebase Admin initialized.");
  const db = getFirestore(firebaseConfig.firestoreDatabaseId);

  // Background task for scheduled messages
  setInterval(async () => {
    try {
      const now = Timestamp.now();
      const scheduledRef = db.collection('scheduledMessages');
      const snapshot = await scheduledRef
        .where('status', '==', 'pending')
        .where('scheduledAt', '<=', now)
        .get();

      for (const doc of snapshot.docs) {
        const data = doc.data();
        try {
          // Send the message
          const messageRef = db.collection('chats').doc(data.chatId).collection('messages').doc(data.id);
          await messageRef.set({
            id: data.id,
            chatId: data.chatId,
            senderId: data.senderId,
            text: data.text,
            status: 'sent',
            createdAt: FieldValue.serverTimestamp(),
          });

          // Update chat lastMessage and updatedAt
          await db.collection('chats').doc(data.chatId).update({
            lastMessage: {
              text: data.text,
              senderId: data.senderId,
              createdAt: FieldValue.serverTimestamp(),
            },
            updatedAt: FieldValue.serverTimestamp(),
          });

          // Update scheduled message status
          await doc.ref.update({ status: 'sent' });

          // Broadcast via socket
          io.to(data.chatId).emit('receive-message', {
            id: data.id,
            chatId: data.chatId,
            senderId: data.senderId,
            text: data.text,
            status: 'sent',
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          console.error('Error sending scheduled message:', error);
          await doc.ref.update({ status: 'failed' });
        }
      }
    } catch (error) {
      console.error('Error in scheduled messages task:', error);
    }
  }, 60000); // Check every minute

  // Socket.IO logic
  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room ${roomId}`);
    });

    socket.on("send-message", (data) => {
      // Broadcast to everyone in the room except sender
      socket.to(data.roomId).emit("receive-message", data);
    });

    socket.on("typing", (data) => {
      socket.to(data.roomId).emit("user-typing", data);
    });

    socket.on("message-status", (data) => {
      socket.to(data.roomId).emit("status-update", data);
    });

    // WebRTC Signaling for Video Calls
    socket.on("call-user", (data) => {
      // data: { to: string, offer: any, from: string, name: string, photoURL: string, isGroup: boolean }
      socket.to(data.to).emit("incoming-call", {
        from: data.from,
        offer: data.offer,
        name: data.name,
        photoURL: data.photoURL,
        isGroup: data.isGroup
      });
    });

    socket.on("answer-call", (data) => {
      // data: { to: string, answer: any }
      socket.to(data.to).emit("call-answered", {
        answer: data.answer,
        from: socket.id
      });
    });

    socket.on("ice-candidate", (data) => {
      // data: { to: string, candidate: any }
      socket.to(data.to).emit("ice-candidate", {
        candidate: data.candidate,
        from: socket.id
      });
    });

    socket.on("end-call", (data) => {
      // data: { to: string }
      socket.to(data.to).emit("call-ended");
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    console.log("Vite server created.");
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
