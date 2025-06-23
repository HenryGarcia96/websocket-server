require('dotenv').config();
const { createServer } = require("http");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const axios = require("axios");

// Crear servidor HTTP
const httpServer = createServer();

// Configurar Socket.IO con CORS
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://127.0.0.1:5500", // frontend permitido
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Conexión a Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD
});

// Mapear sockets conectados por usuario
const userSockets = new Map();

// Middleware de autenticación con Laravel (token JWT)
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Token no proporcionado"));
  }

  try {
    const baseUrl = (process.env.LARAVEL_API_URL || "http://localhost").replace(/\/+$/, '');
    console.log("🔍 Llamando a:", `${baseUrl}/api/me`);

    const response = await axios.get(`${baseUrl}/api/me`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    console.log("✅ Usuario autenticado:", response.data);

    // Guarda los datos del usuario autenticado en el socket
    socket.user = response.data;
    socket.token = token; // guardamos token para llamadas futuras
    next();
  } catch (err) {
    if (err.response) {
      console.error("Error autenticando:", err.response.status, err.response.data);
    } else {
      console.error("Error de red:", err.message);
    }
    next(new Error("Token inválido o expirado"));
  }
});

// Conexión WebSocket del cliente autenticado
io.on("connection", async (socket) => {
  const userId = socket.user.id;
  console.log("✅ Usuario conectado:", socket.user.name, "ID:", userId);

  // Guardar socket por userId
  userSockets.set(userId, socket);

  // --- NUEVO: Obtener notificaciones no leídas y enviarlas ---
  const baseUrl = (process.env.LARAVEL_API_URL || "http://localhost").replace(/\/+$/, '');

  try {
    const notificationsResponse = await axios.get( `${baseUrl}/api/notifications/unread`,{
        headers: { Authorization: `Bearer ${socket.token}` }
      }
    );

    const notifications = Array.isArray(notificationsResponse.data)
      ? notificationsResponse.data
      : notificationsResponse.data.notifications || [];

    notifications.forEach(notification => {
      socket.emit('notification', notification);
    });
  } catch (error) {
    console.error("Error al obtener notificaciones no leídas:", error.message);
  }

  // Escuchar evento para marcar notificaciones como leídas
  socket.on('notifications:markAsRead', async (notificationIds) => {
    if (!Array.isArray(notificationIds) || notificationIds.length === 0) return;

    try {
      await axios.post(
         `${baseUrl}/api/notifications/mark-as-read`,
        { ids: notificationIds },
        { headers: { Authorization: `Bearer ${socket.token}` } }
      );
      console.log(`🔔 Notificaciones marcadas como leídas: ${notificationIds.join(', ')}`);
    } catch (error) {
      console.error("Error al marcar notificaciones como leídas:", error.message);
    }
  });

  socket.on("chat:message", (msg) => {
    console.log(`💬 ${socket.user.name} dice: ${msg}`);
    io.emit("chat:message", {
      user: socket.user.name,
      message: msg
    });
  });

  socket.on("disconnect", () => {
    console.log("🔌 Usuario desconectado:", socket.user.name, "ID:", userId);
    userSockets.delete(userId);
  });
});

// Suscripciones Redis
redis.subscribe(
  ["ccerp_database_laravelchannel"],
  (err, count) => {
    if (err) {
      console.error("❌ Error al suscribirse a Redis:", err);
    } else {
      console.log(`📡 Suscrito a ${count} canal(es) Redis.`);
    }
  }
);

// Nota importante: ioredis no soporta suscripciones con wildcard directamente.
// Por eso, en producción debes suscribirte a cada canal privado dinámicamente o usar patrones con redis.psubscribe.
// Aquí uso psubscribe para canales privados:
redis.psubscribe("ccerp_database_private-user.*", (err, count) => {
  if (err) {
    console.error("❌ Error al pSuscribirse a canales privados:", err);
  } else {
    console.log(`🔒 Suscrito a ${count} canal(es) privados Redis con patrón.`);
  }
});

redis.psubscribe("ccerp_database_private-auditor.*", (err, count) => {
  if (err) {
    console.error("❌ Error al pSuscribirse a canales de auditor:", err);
  } else {
    console.log(`🕵️ Suscrito a ${count} canal(es) de auditor Redis con patrón.`);
  }
});

// Handler para mensajes normales (subscribe)
redis.on("message", (channel, message) => {
  console.log(`📥 [message] Canal: ${channel}`);
  handleRedisMessage(channel, message);
});

// Handler para mensajes por patrón (psubscribe)
redis.on("pmessage", (pattern, channel, message) => {
  console.log(`📥 [pmessage] Patrón: ${pattern}, Canal: ${channel}`);
  handleRedisMessage(channel, message);
});

function handleRedisMessage(channel, message) {
  try {
    const { event, data } = JSON.parse(message);

    if (channel === 'ccerp_database_notification') {
      console.log(`📣 Emitiendo evento público '${event}':`, data);
      io.emit(event, data);

    } else if (channel === 'ccerp_database_laravelchannel') {
      console.log(`📣 Emitiendo evento '${event}' desde laravelchannel:`, data);
      io.emit(event, data);

    } else if (channel.startsWith('ccerp_database_private-user.')) {
      const userIdStr = channel.split('ccerp_database_private-user.')[1];
      const userId = parseInt(userIdStr, 10);

      if (!isNaN(userId)) {
        const socket = userSockets.get(userId);
        if (socket) {
          console.log(`📨 Enviando evento '${event}' a usuario ID ${userId}`);
          socket.emit(event, data);
        } else {
          console.log(`👤 Usuario ${userId} no conectado. Evento '${event}' ignorado.`);
        }
      } else {
        console.warn(`⚠️ Canal privado con userId inválido: ${channel}`);
      }

    } else if (channel.startsWith('ccerp_database_private-auditor.')) {
      const auditorIdStr = channel.split('ccerp_database_private-auditor.')[1];
      const auditorId = parseInt(auditorIdStr, 10);

      if (!isNaN(auditorId)) {
        const socket = userSockets.get(auditorId);
        if (socket) {
          console.log(`🕵️ Enviando evento '${event}' a auditor ID ${auditorId}`);
          socket.emit(event, data);
        } else {
          console.log(`👤 Auditor ${auditorId} no conectado. Evento '${event}' ignorado.`);
        }
      } else {
        console.warn(`⚠️ Canal auditor con ID inválido: ${channel}`);
      }
    }else {
      console.log(`⚠️ Canal no reconocido: ${channel}`);
    }
  } catch (e) {
    console.error("⚠️ Mensaje malformado desde Redis:", message);
  }
}

// Iniciar el servidor WebSocket
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Socket.IO corriendo en puerto ${PORT}`);
});
