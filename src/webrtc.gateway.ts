import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
    OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

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

@WebSocketGateway({ cors: true })
export class WebRtcGateway implements OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    // Store user information: socketId -> { roomId, userName }
    private userInfo = new Map<string, { roomId: string; userName: string }>();

    // Store room host: roomId -> socketId
    private roomHosts = new Map<string, string>();

    @SubscribeMessage('join-room')
    handleJoin(
        @MessageBody() data: JoinRoomData,
        @ConnectedSocket() client: Socket,
    ) {
        const { roomId, userName } = data;

        // Check if user already joined (prevent duplicates)
        const existingUser = this.userInfo.get(client.id);
        if (existingUser && existingUser.roomId === roomId) {
            console.log(`[WebRTC] ${userName} already in room ${roomId}, skipping duplicate join`);
            return;
        }

        console.log(`[WebRTC] ${userName} (${client.id}) attempting to join room: ${roomId}`);

        // Store user info temporarily (even if pending)
        this.userInfo.set(client.id, { roomId, userName });

        const room = this.server.sockets.adapter.rooms.get(roomId);
        const numClients = room ? room.size : 0;

        if (numClients === 0) {
            // First user becomes host automatically
            console.log(`[WebRTC] Room ${roomId} is empty. ${userName} is the new host.`);
            this.roomHosts.set(roomId, client.id);
            this.joinRoom(client, roomId, userName);
        } else {
            // Room exists, ask host for permission
            const hostId = this.roomHosts.get(roomId);

            // Fallback: If hostId is missing but room has people, pick the first one (shouldn't happen often)
            const targetHostId = hostId || room?.values().next().value;

            if (targetHostId) {
                console.log(`[WebRTC] Room ${roomId} has host ${targetHostId}. Requesting permission for ${userName}.`);

                // Notify pending user they are waiting
                client.emit('waiting-for-approval');

                // Notify host
                this.server.to(targetHostId).emit('join-request', {
                    userId: client.id,
                    userName,
                });
            } else {
                // Should not happen if size > 0, but safety net: Join directly if no host found
                console.warn(`[WebRTC] Room ${roomId} exists but no host found. Joining directly.`);
                this.joinRoom(client, roomId, userName);
            }
        }
    }

    private joinRoom(client: Socket, roomId: string, userName: string) {
        // Get existing users in room before joining
        const room = this.server.sockets.adapter.rooms.get(roomId);
        const existingUsers: Array<{ userId: string; userName: string }> = [];

        if (room) {
            room.forEach((socketId) => {
                const userInfoData = this.userInfo.get(socketId);
                if (userInfoData && socketId !== client.id) {
                    existingUsers.push({
                        userId: socketId,
                        userName: userInfoData.userName,
                    });
                }
            });
        }

        // Join the room
        client.join(roomId);

        // Send existing users to the new user
        if (existingUsers.length > 0) {
            client.emit('existing-users', existingUsers);
        }

        // Notify all other users in the room about the new user
        client.to(roomId).emit('user-joined', {
            userId: client.id,
            userName,
        });

        const numClients = room ? room.size + 1 : 1;
        console.log(`[WebRTC] ${userName} joined room ${roomId}. Total clients: ${numClients}`);
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
        const { to, offer, userName } = data;
        console.log(`[WebRTC] Forwarding offer from ${userName} to ${to}`);

        this.server.to(to).emit('offer', {
            from: client.id,
            offer,
            userName,
        });
    }

    @SubscribeMessage('answer')
    handleAnswer(
        @MessageBody() data: AnswerData,
        @ConnectedSocket() client: Socket,
    ) {
        const { to, answer } = data;
        console.log(`[WebRTC] Forwarding answer to ${to}`);

        this.server.to(to).emit('answer', {
            from: client.id,
            answer,
        });
    }

    @SubscribeMessage('ice-candidate')
    handleIce(
        @MessageBody() data: IceCandidateData,
        @ConnectedSocket() client: Socket,
    ) {
        const { to, candidate } = data;
        console.log(`[WebRTC] Forwarding ICE candidate to ${to}`);

        this.server.to(to).emit('ice-candidate', {
            from: client.id,
            candidate,
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
        const { roomId, kind, isOn } = data;
        console.log(`[WebRTC] ${client.id} toggled ${kind} to ${isOn}`);

        client.to(roomId).emit('media-status-update', {
            userId: client.id,
            kind,
            isOn,
        });
    }

    handleDisconnect(client: Socket) {
        const userInfoData = this.userInfo.get(client.id);
        if (userInfoData) {
            this.handleUserLeave(client, userInfoData.roomId);
        }
        // Also cleanup if they were just connected but not fully joined/tracked in userInfo logic needed?
        // userInfo is set on join attempt, so it should be there.
    }

    private handleUserLeave(client: Socket, roomId: string) {
        const userInfoData = this.userInfo.get(client.id);
        console.log(`[WebRTC] ${userInfoData?.userName || 'User'} leaving room: ${roomId}`);

        client.leave(roomId);
        client.to(roomId).emit('user-left', {
            userId: client.id,
            userName: userInfoData?.userName,
        });

        this.userInfo.delete(client.id);

        // Check if host left
        if (this.roomHosts.get(roomId) === client.id) {
            const room = this.server.sockets.adapter.rooms.get(roomId);
            if (room && room.size > 0) {
                // Assign new host (next available user)
                const newHostId = room.values().next().value;
                this.roomHosts.set(roomId, newHostId);
                console.log(`[WebRTC] Host left room ${roomId}. New host is ${newHostId}`);
                // Optional: Notify new host they are the host now
            } else {
                this.roomHosts.delete(roomId);
                console.log(`[WebRTC] Room ${roomId} is now empty. Cleared host.`);
            }
        }
    }
}
