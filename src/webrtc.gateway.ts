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

        console.log(`[WebRTC] ${userName} (${client.id}) joining room: ${roomId}`);

        // Store user info
        this.userInfo.set(client.id, { roomId, userName });

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
        console.log(`[WebRTC] Room ${roomId} now has ${numClients} client(s)`);
        console.log(`[WebRTC] Notified ${existingUsers.length} existing users about ${userName}`);
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
        const userInfoData = this.userInfo.get(client.id);
        console.log(`[WebRTC] ${userInfoData?.userName || 'User'} leaving room: ${roomId}`);

        client.leave(roomId);
        client.to(roomId).emit('user-left', {
            userId: client.id,
            userName: userInfoData?.userName,
        });

        this.userInfo.delete(client.id);
    }

    handleDisconnect(client: Socket) {
        const userInfoData = this.userInfo.get(client.id);
        if (userInfoData) {
            const { roomId, userName } = userInfoData;
            console.log(`[WebRTC] ${userName} disconnected from room: ${roomId}`);

            client.to(roomId).emit('user-left', {
                userId: client.id,
                userName,
            });

            this.userInfo.delete(client.id);
        }
    }
}
