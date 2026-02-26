import { Server } from "socket.io";
import { isOriginAllowed } from "../config/network.js";
import { notificationService } from "./notificationService.js";

class SocketService {
  constructor() {
    this.io = null;
    this.activeTechnicians = new Map();
  }

  init(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: (origin, callback) => {
          if (isOriginAllowed(origin)) return callback(null, true);
          return callback(new Error(`CORS policy violation for origin: ${origin}`));
        },
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Authorization", "Content-Type"],
      },
    });

    this.io.on("connection", (socket) => {
      console.log(`[Socket] connected ${socket.id}`);

      socket.on("join_technician_room", (technicianId) => {
        if (!technicianId) return;
        const id = String(technicianId);
        this.activeTechnicians.set(id, socket.id);
        socket.join(`technician_${id}`);
      });

      socket.on("join_user_room", (userId) => {
        if (!userId) return;
        socket.join(`user_${String(userId)}`);
      });

      socket.on("join_request_room", (requestId) => {
        if (!requestId) return;
        socket.join(`request_${String(requestId)}`);
      });

      socket.on("technician:location_update", (data = {}) => {
        const technicianId = data.technicianId ? String(data.technicianId) : null;
        if (!technicianId) return;

        this.io.to(`technician_${technicianId}`).emit("location_update", data);
        this.io.emit(`technician:${technicianId}:location`, data);

        if (data.requestId) {
          this.io.to(`request_${String(data.requestId)}`).emit("location_update", data);
        }
      });

      socket.on("disconnect", () => {
        for (const [technicianId, socketId] of this.activeTechnicians.entries()) {
          if (socketId === socket.id) {
            this.activeTechnicians.delete(technicianId);
            break;
          }
        }
      });
    });
  }

  notifyTechnician(technicianId, event, data) {
    if (!this.io || !technicianId) return;
    this.io.to(`technician_${String(technicianId)}`).emit(event, data);

    // Also send push notification
    notificationService.sendPushNotification(technicianId, 'technician', event, data).catch(err => {
      console.error("[SocketService] Push notification error:", err);
    });
  }

  notifyUser(userId, event, data) {
    if (!this.io || !userId) return;
    const room = `user_${String(userId)}`;
    this.io.to(room).emit(event, data);
    if (data?.requestId) {
      this.io.to(`request_${String(data.requestId)}`).emit(event, data);
    }

    // Also send push notification
    notificationService.sendPushNotification(userId, 'user', event, data).catch(err => {
      console.error("[SocketService] Push notification error:", err);
    });
  }

  notifyAllTechnicians(event, data) {
    if (!this.io) return;
    this.io.emit(event, data);
  }

  broadcast(event, data) {
    if (!this.io) return;
    this.io.emit(event, data);
  }
}

export const socketService = new SocketService();

