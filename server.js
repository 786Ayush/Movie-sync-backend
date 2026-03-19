const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── File Upload ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files allowed'));
  },
});

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Return a relative path — the Next.js proxy maps /uploads → backend:4000/uploads
  const fileUrl = `/uploads/${req.file.filename}`;
  console.log(`[Upload] ✅ File ready at: http://localhost:4000${fileUrl}`);
  res.json({ url: fileUrl });
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// rooms[roomId] = { hostId, users: {}, watchState: { url, playing, currentTime } }
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[Server] 🔌 Connected: ${socket.id}`);

  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        hostId: socket.id,
        users: {},
        watchState: { url: '', playing: false, currentTime: 0 },
      };
      console.log(`[Server] 🏠 Room created: ${roomId}. Host: ${socket.id}`);
    }

    rooms[roomId].users[socket.id] = { name: userName, socketId: socket.id };

    // Tell everyone the current host
    io.to(roomId).emit('sync-host', rooms[roomId].hostId);

    // Send existing users to the new joiner (so they can call them)
    const otherUsers = Object.values(rooms[roomId].users).filter(u => u.socketId !== socket.id);
    socket.emit('room-users', otherUsers);

    // Tell existing users that someone joined
    socket.to(roomId).emit('user-joined', { socketId: socket.id, name: userName });

    // Sync current watch state to new joiner
    socket.emit('watch:sync', rooms[roomId].watchState);

    console.log(`[Server] 👤 ${userName} (${socket.id}) joined ${roomId}. Users: ${Object.keys(rooms[roomId].users).length}`);

    // ─── WebRTC Signaling (ISOLATED — do not touch these) ───────────────────
    socket.on('webrtc-offer', (data) => {
      console.log(`[WebRTC] ➡️  OFFER from ${socket.id} → ${data.target}`);
      io.to(data.target).emit('webrtc-offer', data);
    });

    socket.on('webrtc-answer', (data) => {
      console.log(`[WebRTC] ➡️  ANSWER from ${socket.id} → ${data.target}`);
      io.to(data.target).emit('webrtc-answer', data);
    });

    socket.on('webrtc-ice-candidate', (data) => {
      io.to(data.target).emit('webrtc-ice-candidate', data);
    });

    // ─── Chat ────────────────────────────────────────────────────────────────
    socket.on('send-message', ({ text }) => {
      const message = {
        id: Date.now().toString(),
        senderId: socket.id,
        senderName: userName,
        text,
        timestamp: Date.now(),
      };
      io.to(roomId).emit('receive-message', message);
    });

    // ─── Watch Party (ISOLATED — uses watch:* prefix) ────────────────────────
    socket.on('watch:load', ({ url }) => {
      if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) return;
      rooms[roomId].watchState = { url, playing: false, currentTime: 0 };
      console.log(`[Watch] 🎬 Host loaded: ${url}`);
      io.to(roomId).emit('watch:load', { url });
    });

    socket.on('watch:play', ({ currentTime }) => {
      if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) return;
      rooms[roomId].watchState.playing = true;
      rooms[roomId].watchState.currentTime = currentTime;
      console.log(`[Watch] ▶️  Play at ${currentTime}s`);
      socket.to(roomId).emit('watch:play', { currentTime });
    });

    socket.on('watch:pause', ({ currentTime }) => {
      if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) return;
      rooms[roomId].watchState.playing = false;
      rooms[roomId].watchState.currentTime = currentTime;
      console.log(`[Watch] ⏸️  Pause at ${currentTime}s`);
      socket.to(roomId).emit('watch:pause', { currentTime });
    });

    socket.on('watch:seek', ({ currentTime }) => {
      if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) return;
      rooms[roomId].watchState.currentTime = currentTime;
      console.log(`[Watch] ⏩ Seek to ${currentTime}s`);
      socket.to(roomId).emit('watch:seek', { currentTime });
    });

    // ─── Disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (!rooms[roomId]) return;
      const name = rooms[roomId].users[socket.id]?.name || socket.id;
      delete rooms[roomId].users[socket.id];
      console.log(`[Server] 🔌 ${name} left ${roomId}`);

      // Host handover
      if (rooms[roomId].hostId === socket.id) {
        const remaining = Object.keys(rooms[roomId].users);
        if (remaining.length > 0) {
          rooms[roomId].hostId = remaining[0];
          io.to(roomId).emit('sync-host', rooms[roomId].hostId);
          console.log(`[Server] 👑 New host: ${rooms[roomId].hostId}`);
        }
      }

      socket.to(roomId).emit('user-disconnected', socket.id);

      if (Object.keys(rooms[roomId].users).length === 0) {
        delete rooms[roomId];
        console.log(`[Server] 🗑️  Room ${roomId} deleted`);
      }
    });
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`[Server] ✅ Running on port ${PORT}`));
