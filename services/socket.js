import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { isOriginAllowed } from "../config/network.js";
import { getPool } from "../db.js";
import { notificationService } from "./notificationService.js";
import { logLiveTrackingDiagnostic } from './liveTrackingDiagnostics.js';

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) throw new SocketAuthError('JWT_SECRET is not configured.');
  return secret;
}

function resolveSocketToken(handshake = {}) {
  const authToken = handshake?.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();

  const authorization = String(handshake?.headers?.authorization || '').trim();
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

export class SocketAuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'SocketAuthError';
    this.code = 'UNAUTHENTICATED';
  }
}

export function authenticateSocketToken(token) {
  if (!token || typeof token !== 'string') throw new SocketAuthError();

  try {
    const payload = jwt.verify(token, getJwtSecret());
    const role = String(payload?.role || payload?.type || 'user').trim().toLowerCase();
    const id = payload?.id ?? payload?.userId ?? payload?.technicianId ?? payload?.email;
    if (!id || !['user', 'technician', 'admin'].includes(role)) throw new SocketAuthError();
    return {
      id: String(id),
      email: String(payload?.email || ''),
      role,
    };
  } catch (error) {
    if (error instanceof SocketAuthError) throw error;
    throw new SocketAuthError();
  }
}

export function createSocketAccessControl({ getPool: resolvePool = getPool } = {}) {
  if (typeof resolvePool !== 'function') throw new TypeError('getPool must be a function.');

  return {
    async canSubscribeToRequest(identity, requestId) {
      return Boolean(await this.getTrackingRequest(identity, requestId));
    },

    async getTrackingRequest(identity, requestId) {
      if (!identity?.id || !requestId || !['user', 'admin'].includes(identity.role)) return null;

      const pool = await resolvePool();
      const isAdmin = identity.role === 'admin';
      const [rows] = await pool.execute(
        isAdmin
          ? `SELECT id, technician_id FROM service_requests WHERE id = ? LIMIT 1`
          : `SELECT id, technician_id FROM service_requests WHERE id = ? AND user_id = ? LIMIT 1`,
        isAdmin ? [requestId] : [requestId, identity.id],
      );
      const request = rows?.[0];
      if (!request) return null;
      return {
        requestId: String(request.id),
        technicianId: request.technician_id == null ? null : String(request.technician_id),
      };
    },
  };
}

export class SocketService {
  constructor() {
    this.io = null;
    this.activeTechnicians = new Map();
  }

  init(httpServer, {
    accessControl = createSocketAccessControl(),
    trackingIngestion = null,
    socketAdapter = null,
    onTrackingAccepted = null,
  } = {}) {
    this.accessControl = accessControl;
    this.trackingIngestion = trackingIngestion;
    this.onTrackingAccepted = typeof onTrackingAccepted === 'function'
      ? onTrackingAccepted
      : ({ location }) => this.publishTrackingLocation(location);
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
    if (socketAdapter) this.io.adapter(socketAdapter);

    this.io.use((socket, next) => {
      try {
        socket.data.identity = authenticateSocketToken(resolveSocketToken(socket.handshake));
        next();
      } catch (error) {
        next(new Error(error instanceof SocketAuthError ? 'Unauthorized' : 'Socket authentication failed'));
      }
    });

    this.io.on("connection", (socket) => {
      console.log(`[Socket] connected ${socket.id}`);
      logLiveTrackingDiagnostic('socket_connected', {
        socketId: socket.id,
        role: socket.data.identity?.role || null,
        identityId: socket.data.identity?.id || null,
      });

      socket.on("join_technician_room", (technicianId, acknowledgement = () => {}) => {
        const identity = socket.data.identity;
        const id = String(technicianId || '');
        if (identity?.role !== 'technician' || !id || id !== String(identity.id)) {
          acknowledgement({ ok: false, code: 'FORBIDDEN' });
          return;
        }
        this.activeTechnicians.set(id, socket.id);
        socket.join(`technician_${id}`);
        acknowledgement({ ok: true });
      });

      socket.on("join_user_room", (userId, acknowledgement = () => {}) => {
        const identity = socket.data.identity;
        const id = String(userId || '');
        if (identity?.role !== 'user' || !id || id !== String(identity.id)) {
          acknowledgement({ ok: false, code: 'FORBIDDEN' });
          return;
        }
        socket.join(`user_${id}`);
        acknowledgement({ ok: true });
      });

      const subscribeToRequest = async (requestId, acknowledgement = () => {}) => {
        try {
          const normalizedRequestId = String(requestId || '');
          const trackingRequest = normalizedRequestId
            ? await this.accessControl.getTrackingRequest(socket.data.identity, normalizedRequestId)
            : null;
          if (!trackingRequest) {
            logLiveTrackingDiagnostic('subscription_rejected', {
              socketId: socket.id,
              role: socket.data.identity?.role || null,
              identityId: socket.data.identity?.id || null,
              requestId: normalizedRequestId,
              code: 'FORBIDDEN',
            });
            acknowledgement({ ok: false, code: 'FORBIDDEN' });
            return;
          }
          const room = `request_${normalizedRequestId}`;
          socket.join(room);
          let location = null;
          if (this.trackingIngestion && trackingRequest.technicianId) {
            location = await this.trackingIngestion.getRecoverySnapshot({
              technicianId: trackingRequest.technicianId,
              requestId: normalizedRequestId,
            });
          }
          logLiveTrackingDiagnostic('subscription_accepted', {
            socketId: socket.id,
            role: socket.data.identity?.role || null,
            identityId: socket.data.identity?.id || null,
            requestId: normalizedRequestId,
            room,
            recoverySequenceId: location?.sequenceId ?? null,
          });
          acknowledgement({ ok: true, location });
        } catch {
          acknowledgement({ ok: false, code: 'STORE_UNAVAILABLE' });
        }
      };

      socket.on("join_request_room", subscribeToRequest);
      socket.on("tracking:subscribe:v1", ({ requestId } = {}, acknowledgement = () => {}) => {
        void subscribeToRequest(requestId, acknowledgement);
      });

      socket.on("tracking:location:v1", (data = {}, acknowledgement = () => {}) => {
        logLiveTrackingDiagnostic('location_received', {
          socketId: socket.id,
          role: socket.data.identity?.role || null,
          technicianId: socket.data.identity?.id || null,
          requestId: data?.jobId ?? data?.requestId ?? null,
          sequenceId: data?.sequenceId ?? null,
          lat: data?.lat ?? null,
          lng: data?.lng ?? null,
          recordedAt: data?.recordedAt ?? null,
        });
        if (!this.trackingIngestion) {
          acknowledgement({ ok: false, code: 'STORE_UNAVAILABLE' });
          return;
        }
        void this.trackingIngestion.ingest({
          identity: socket.data.identity,
          payload: data,
          source: 'socket',
        }).then(async (result) => {
          logLiveTrackingDiagnostic(result.ok ? 'location_accepted' : 'location_rejected', {
            socketId: socket.id,
            technicianId: socket.data.identity?.id || null,
            requestId: result.location?.requestId ?? data?.jobId ?? null,
            sequenceId: result.location?.sequenceId ?? data?.sequenceId ?? null,
            code: result.code ?? null,
          });
          if (result.ok) await this.publishAcceptedTracking(result);
          acknowledgement(result);
        }).catch((error) => {
          logLiveTrackingDiagnostic('location_handler_failure', {
            socketId: socket.id,
            technicianId: socket.data.identity?.id || null,
            message: error?.message || String(error),
          });
          acknowledgement({ ok: false, code: 'STORE_UNAVAILABLE' });
        });
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

  publishTechnicianLocation(data = {}, event = "location_update") {
    if (!this.io) return;
    const technicianId = data.technicianId ? String(data.technicianId) : null;
    if (!technicianId) return;

    this.io.to(`technician_${technicianId}`).emit("location_update", data);

    if (data.requestId) {
      this.io.to(`request_${String(data.requestId)}`).emit(event, data);
    }
  }

  publishTrackingLocation(location) {
    if (!this.io || !location?.requestId) return;
    const room = `request_${String(location.requestId)}`;
    logLiveTrackingDiagnostic('room_emission', {
      room,
      requestId: String(location.requestId),
      technicianId: location.technicianId ?? null,
      sequenceId: location.sequenceId ?? null,
      lat: location.lat ?? null,
      lng: location.lng ?? null,
    });
    this.io.to(room).emit('tracking:location:v1', location);
    this.io.to(room).emit('technician:location_update', location);
  }

  publishAcceptedTracking(result) {
    return Promise.resolve(this.onTrackingAccepted(result));
  }

  broadcast(event, data) {
    if (!this.io) return;
    this.io.emit(event, data);
  }
}

export const socketService = new SocketService();

