import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
    OnGatewayDisconnect,
    OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

interface JoinRoomData {
    roomId: string;
    userName: string;
}

interface OfferData {
    roomId: string;
    to: string;
    offer: any;
    userName: string;
}

interface AnswerData {
    roomId: string;
    to: string;
    answer: any;
}

interface IceCandidateData {
    roomId: string;
    to: string;
    candidate: any;
}

interface UserInfo {
    roomId: string;
    userName: string;
    joinedAt: number;
}

// PERFORMANCE OPTIMIZATION: Use WebSocket compression and optimize transport
@WebSocketGateway({
    cors: true,
    transports: ['websocket'], // Prefer WebSocket over polling for speed
    pingTimeout: 60000,
    pingInterval: 25000,
    perMessageDeflate: { // Enable compression for large messages
        threshold: 1024, // Only compress messages > 1KB
    },
    maxHttpBufferSize: 1e8, // 100MB for large media
})
export class WebRtcGateway implements OnGatewayDisconnect, OnGatewayConnection {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(WebRtcGateway.name);

    // OPTIMIZED: Use Map for O(1) lookups instead of arrays
    private userInfo = new Map<string, UserInfo>();
    private roomHosts = new Map<string, string>();

    // PERFORMANCE: Cache room participants for faster lookups
    private roomParticipants = new Map<string, Set<string>>();

    // PERFORMANCE: Debounce timers for batch operations
    private cleanupTimers = new Map<string, NodeJS.Timeout>();

    // Connection tracking for rate limiting
    private connectionAttempts = new Map<string, number[]>();

    handleConnection(client: Socket) {
        const ip = client.handshake.address;

        // SECURITY & PERFORMANCE: Rate limiting
        const now = Date.now();
        const attempts = this.connectionAttempts.get(ip) || [];
        const recentAttempts = attempts.filter(time => now - time < 60000); // Last minute

        if (recentAttempts.length > 50) { // Max 50 connections per minute per IP
            this.logger.warn(`Rate limit exceeded for IP: ${ip}`);
            client.disconnect();
            return;
        }

        recentAttempts.push(now);
        this.connectionAttempts.set(ip, recentAttempts);

        this.logger.log(`Client connected: ${client.id} from ${ip}`);
    }

    @SubscribeMessage('join-room')
    handleJoin(
        @MessageBody() data: JoinRoomData,
        @ConnectedSocket() client: Socket,
    ) {
        const { roomId, userName } = data;

        // PERFORMANCE: Check if user already joined (prevent duplicates)
        const existingUser = this.userInfo.get(client.id);
        if (existingUser && existingUser.roomId === roomId) {
            this.logger.log(`${userName} already in room ${roomId}, skipping duplicate join`);
            return;
        }

        this.logger.log(`${userName} (${client.id}) attempting to join room: ${roomId}`);

        // OPTIMIZED: Store user info with timestamp for analytics
        this.userInfo.set(client.id, {
            roomId,
            userName,
            joinedAt: Date.now()
        });

        // PERFORMANCE: Use cached room size instead of querying adapter repeatedly
        const participants = this.roomParticipants.get(roomId);
        const numClients = participants ? participants.size : 0;

        if (numClients === 0) {
            // First user becomes host automatically
            this.logger.log(`Room ${roomId} is empty. ${userName} is the new host.`);
            this.roomHosts.set(roomId, client.id);
            this.joinRoom(client, roomId, userName);
        } else {
            // Room exists, ask host for permission
            const hostId = this.roomHosts.get(roomId);

            // PERFORMANCE: Fast lookup for host
            const targetHostId = hostId || participants?.values().next().value;

            if (targetHostId) {
                this.logger.log(`Room ${roomId} has host ${targetHostId}. Requesting permission for ${userName}.`);

                // Notify pending user they are waiting
                client.emit('waiting-for-approval');

                // Notify host (single emit, no broadcast)
                this.server.to(targetHostId).emit('join-request', {
                    userId: client.id,
                    userName,
                });
            } else {
                // Safety net: Join directly if no host found
                this.logger.warn(`Room ${roomId} exists but no host found. Joining directly.`);
                this.joinRoom(client, roomId, userName);
            }
        }
    }

    private joinRoom(client: Socket, roomId: string, userName: string) {
        // PERFORMANCE: Use cached participants instead of querying adapter
        const participants = this.roomParticipants.get(roomId) || new Set<string>();
        const existingUsers: Array<{ userId: string; userName: string }> = [];

        // OPTIMIZED: Build existing users list from cache
        participants.forEach((socketId) => {
            const userInfoData = this.userInfo.get(socketId);
            if (userInfoData && socketId !== client.id) {
                existingUsers.push({
                    userId: socketId,
                    userName: userInfoData.userName,
                });
            }
        });

        // Join the room
        client.join(roomId);

        // PERFORMANCE: Update cache
        participants.add(client.id);
        this.roomParticipants.set(roomId, participants);

        // Send existing users to the new user (single emit)
        if (existingUsers.length > 0) {
            client.emit('existing-users', existingUsers);
        }

        // OPTIMIZED: Notify all other users in the room about the new user (single broadcast)
        client.to(roomId).emit('user-joined', {
            userId: client.id,
            userName,
        });

        this.logger.log(`${userName} joined room ${roomId}. Total clients: ${participants.size}`);
    }

    @SubscribeMessage('admit-user')
    handleAdmit(
        @MessageBody() data: { userId: string; roomId: string },
        @ConnectedSocket() client: Socket,
    ) {
        const { userId, roomId } = data;

        // Verify request comes from host
        const hostId = this.roomHosts.get(roomId);
        if (hostId !== client.id) {
            console.warn(`[WebRTC] Unauthorized admit attempt by ${client.id} for room ${roomId}`);
            return;
        }

        console.log(`[WebRTC] Host admitted ${userId} to room ${roomId}`);

        const pendingSocket = this.server.sockets.sockets.get(userId);
        if (pendingSocket) {
            const userInfo = this.userInfo.get(userId);
            if (userInfo) {
                // Execute actual join
                this.joinRoom(pendingSocket, roomId, userInfo.userName);
                // Notify user they were admitted
                pendingSocket.emit('join-approved');
            }
        }
    }

    @SubscribeMessage('reject-user')
    handleReject(
        @MessageBody() data: { userId: string; roomId: string },
        @ConnectedSocket() client: Socket,
    ) {
        const { userId, roomId } = data;

        // Verify request comes from host
        const hostId = this.roomHosts.get(roomId);
        if (hostId !== client.id) {
            return;
        }

        console.log(`[WebRTC] Host rejected ${userId} from room ${roomId}`);

        const pendingSocket = this.server.sockets.sockets.get(userId);
        if (pendingSocket) {
            pendingSocket.emit('join-rejected');
            // Cleanup their temp info
            this.userInfo.delete(userId);
        }
    }

    @SubscribeMessage('offer')
    handleOffer(
        @MessageBody() data: OfferData,
        @ConnectedSocket() client: Socket,
    ) {
        // PERFORMANCE: Direct forwarding without logging in production
        // Use logger.debug for development only
        this.server.to(data.to).emit('offer', {
            from: client.id,
            offer: data.offer,
            userName: data.userName,
        });
    }

    @SubscribeMessage('answer')
    handleAnswer(
        @MessageBody() data: AnswerData,
        @ConnectedSocket() client: Socket,
    ) {
        // PERFORMANCE: Fastest possible forwarding
        this.server.to(data.to).emit('answer', {
            from: client.id,
            answer: data.answer,
        });
    }

    @SubscribeMessage('ice-candidate')
    handleIce(
        @MessageBody() data: IceCandidateData,
        @ConnectedSocket() client: Socket,
    ) {
        // PERFORMANCE: ICE candidates need to be forwarded ASAP
        // No logging to maximize speed
        this.server.to(data.to).emit('ice-candidate', {
            from: client.id,
            candidate: data.candidate,
        });
    }

    @SubscribeMessage('leave-room')
    handleLeave(
        @MessageBody() roomId: string,
        @ConnectedSocket() client: Socket,
    ) {
        this.handleUserLeave(client, roomId);
    }

    @SubscribeMessage('toggle-media')
    handleMediaToggle(
        @MessageBody() data: { roomId: string; kind: 'audio' | 'video'; isOn: boolean },
        @ConnectedSocket() client: Socket,
    ) {
        // PERFORMANCE: Fast broadcast to room
        client.to(data.roomId).emit('media-status-update', {
            userId: client.id,
            kind: data.kind,
            isOn: data.isOn,
        });
    }

    @SubscribeMessage('screen-share-status')
    handleScreenShareStatus(
        @MessageBody() data: { roomId: string; isSharing: boolean },
        @ConnectedSocket() client: Socket,
    ) {
        // PERFORMANCE: Fast broadcast for screen sharing
        client.to(data.roomId).emit('participant-screen-share', {
            userId: client.id,
            userName: this.userInfo.get(client.id)?.userName,
            isSharing: data.isSharing,
        });
    }

    handleDisconnect(client: Socket) {
        const userInfoData = this.userInfo.get(client.id);
        if (userInfoData) {
            this.handleUserLeave(client, userInfoData.roomId);
        }

        // PERFORMANCE: Cleanup connection tracking
        this.cleanupConnectionTracking();
    }

    private handleUserLeave(client: Socket, roomId: string) {
        const userInfoData = this.userInfo.get(client.id);
        this.logger.log(`${userInfoData?.userName || 'User'} leaving room: ${roomId}`);

        // PERFORMANCE: Update cache first
        const participants = this.roomParticipants.get(roomId);
        if (participants) {
            participants.delete(client.id);
            if (participants.size === 0) {
                // MEMORY: Clean up empty room cache
                this.roomParticipants.delete(roomId);
            } else {
                this.roomParticipants.set(roomId, participants);
            }
        }

        client.leave(roomId);

        // OPTIMIZED: Single broadcast to notify others
        client.to(roomId).emit('user-left', {
            userId: client.id,
            userName: userInfoData?.userName,
        });

        // MEMORY: Clean up user info
        this.userInfo.delete(client.id);

        // PERFORMANCE: Check if host left and reassign efficiently
        if (this.roomHosts.get(roomId) === client.id) {
            if (participants && participants.size > 0) {
                // Assign new host from cache (O(1) operation)
                const newHostId = participants.values().next().value;
                this.roomHosts.set(roomId, newHostId);
                this.logger.log(`Host left room ${roomId}. New host is ${newHostId}`);

                // Notify new host
                this.server.to(newHostId).emit('host-assigned', { roomId });
            } else {
                // MEMORY: Clean up empty room
                this.roomHosts.delete(roomId);
                this.logger.log(`Room ${roomId} is now empty. Cleared host.`);
            }
        }

        // PERFORMANCE: Debounced cleanup for empty rooms
        this.scheduleRoomCleanup(roomId);
    }

    // PERFORMANCE: Debounced cleanup to avoid frequent operations
    private scheduleRoomCleanup(roomId: string) {
        // Clear existing timer
        const existingTimer = this.cleanupTimers.get(roomId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Schedule cleanup after 30 seconds of inactivity
        const timer = setTimeout(() => {
            const participants = this.roomParticipants.get(roomId);
            if (!participants || participants.size === 0) {
                this.roomParticipants.delete(roomId);
                this.roomHosts.delete(roomId);
                this.cleanupTimers.delete(roomId);
                this.logger.log(`Cleaned up empty room: ${roomId}`);
            }
        }, 30000);

        this.cleanupTimers.set(roomId, timer);
    }

    // MEMORY: Periodic cleanup of old connection attempts
    private cleanupConnectionTracking() {
        const now = Date.now();
        const oneHourAgo = now - 3600000;

        this.connectionAttempts.forEach((attempts, ip) => {
            const recentAttempts = attempts.filter(time => time > oneHourAgo);
            if (recentAttempts.length === 0) {
                this.connectionAttempts.delete(ip);
            } else {
                this.connectionAttempts.set(ip, recentAttempts);
            }
        });
    }
}
