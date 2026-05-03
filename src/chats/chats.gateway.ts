import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ChatsService } from './chats.service';
import { MessageType } from '@prisma/client';

// ======================================================================
// CHATS GATEWAY - Real-time Chat qua WebSocket (Socket.io) + JWT Auth
// ======================================================================
// Flutter kết nối:
//   final socket = io('http://<IP>:3000', {
//     'auth': { 'token': '<JWT_TOKEN>' },  // ← Gửi token qua auth
//   });
// ======================================================================
@WebSocketGateway({
  cors: {
    origin: '*', // Dev: cho phép mọi origin. Production nên giới hạn.
  },
})
export class ChatsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Tham chiếu đến Socket.io Server instance
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly chatsService: ChatsService,
    private readonly jwtService: JwtService, // Inject JwtService để xác thực token
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // XỬ LÝ KẾT NỐI MỚI (Xác thực JWT)
  // Client phải gửi token qua: io(url, { auth: { token: '...' } })
  // ─────────────────────────────────────────────────────────────────
  async handleConnection(client: Socket) {
    try {
      // Bước 1: Lấy token từ handshake.auth (chuẩn Socket.io)
      const token = client.handshake.auth?.token as string;

      if (!token) {
        console.warn(
          `🚫 [WS] Kết nối bị từ chối: Không có token (socket: ${client.id})`,
        );
        client.emit('error_message', {
          message: 'Không có token xác thực. Vui lòng đăng nhập lại.',
        });
        client.disconnect();
        return;
      }

      // Bước 2: Xác thực token bằng JwtService
      const payload = await this.jwtService.verifyAsync(token);

      // Bước 3: Lưu userId đã xác thực vào client.data
      client.data.userId = payload.sub; // sub = userId (theo chuẩn JWT)

      // Bước 4: Tự động tham gia phòng cá nhân (để nhận thông báo inbox real-time)
      const userRoom = `user_${payload.sub}`;
      client.join(userRoom);

      console.log(
        `⚡ [WS] User ${payload.sub} authenticated & joined ${userRoom} (socket: ${client.id})`,
      );
    } catch (error) {
      // Token hết hạn, bị sửa đổi, hoặc không hợp lệ
      console.warn(
        `🚫 [WS] Kết nối bị từ chối: Token không hợp lệ (socket: ${client.id}) - ${error.message}`,
      );
      client.emit('error_message', {
        message: 'Token không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
      });
      client.disconnect();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // XỬ LÝ NGẮT KẾT NỐI
  // ─────────────────────────────────────────────────────────────────
  handleDisconnect(client: Socket) {
    // client.data.userId có thể undefined nếu bị disconnect do auth fail
    const userId = client.data?.userId ?? 'unknown';
    console.log(`🔌 [WS] User ${userId} disconnected (socket: ${client.id})`);
  }

  // ─────────────────────────────────────────────────────────────────
  // SỰ KIỆN: join_room
  // Client gửi: socket.emit('join_room', { sessionId: 1 })
  // Server cho client vào phòng "room_1"
  // ─────────────────────────────────────────────────────────────────
  @SubscribeMessage('join_room')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId: number },
  ) {
    const roomName = `room_${data.sessionId}`;
    client.join(roomName);

    console.log(
      `🚪 [WS] User ${client.data.userId} joined ${roomName}`,
    );

    // Phản hồi lại cho client biết đã vào phòng thành công
    return {
      event: 'joined_room',
      data: {
        sessionId: data.sessionId,
        room: roomName,
        message: `Đã vào phòng chat ${data.sessionId}`,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // SỰ KIỆN: send_message
  // Client gửi: socket.emit('send_message', {
  //   sessionId: 1,
  //   content: "Xin chào!",
  //   type: "TEXT",
  //   metadata: null
  // })
  // Server: Lưu DB → Phát tin nhắn tới toàn bộ phòng
  // ─────────────────────────────────────────────────────────────────
  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      sessionId: number;
      content: string;
      type: string;
      metadata?: Record<string, any>;
    },
  ) {
    try {
      const userId = client.data.userId as number;
      const roomName = `room_${data.sessionId}`;

      // Bước 1: Lưu tin nhắn vào Database thông qua ChatsService
      const savedMessage = await this.chatsService.sendMessage(
        data.sessionId,
        userId,
        {
          type: data.type as MessageType,
          content: data.content,
          metadata: data.metadata,
        },
      );

      // Bước 2: Phát tin nhắn tới TẤT CẢ mọi người trong phòng (bao gồm cả người gửi)
      this.server.to(roomName).emit('new_message', savedMessage);

      // Bước 3: Phát tín hiệu cập nhật hộp thư (inbox) cho người nhận
      // Tìm session để biết ai là người nhận
      const session = await this.chatsService.getSessionById(data.sessionId);
      if (session) {
        const recipientId = userId === session.userId ? session.technicianId : session.userId;
        if (recipientId) {
          const recipientRoom = `user_${recipientId}`;
          this.server.to(recipientRoom).emit('inbox_update', {
            sessionId: data.sessionId,
            lastMessage: savedMessage,
          });
        }
      }

      console.log(
        `💬 [WS] User ${userId} sent message in ${roomName}: "${data.content.substring(0, 30)}..."`,
      );

      // Trả về cho người gửi xác nhận
      return { event: 'message_sent', data: savedMessage };
    } catch (error) {
      console.error(`❌ [WS] Lỗi gửi tin nhắn:`, error.message);

      // Gửi lỗi riêng cho client gửi
      client.emit('error_message', {
        message: 'Không thể gửi tin nhắn: ' + error.message,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // SỰ KIỆN: mark_as_read (Đánh dấu đã xem)
  // Client gửi: socket.emit('mark_as_read', { sessionId: 1, messageId: 5 })
  // Server: Cập nhật DB → Phát sự kiện "message_read" tới phòng
  // → Flutter nhận được và hiện chữ "Đã xem" dưới tin nhắn
  // ─────────────────────────────────────────────────────────────────
  @SubscribeMessage('mark_as_read')
  async handleMarkAsRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId: number; messageId: number },
  ) {
    try {
      const userId = client.data.userId as number;
      const roomName = `room_${data.sessionId}`;

      // Bước 1: Cập nhật isRead = true trong Database
      const updatedMessage = await this.chatsService.markAsRead(
        data.messageId,
      );

      // Bước 2: Phát sự kiện "message_read" tới toàn bộ phòng
      // Để phía Flutter biết tin nhắn nào đã được xem bởi ai
      this.server.to(roomName).emit('message_read', {
        messageId: data.messageId,
        readBy: userId,
        readAt: new Date().toISOString(),
      });

      console.log(
        `👁️ [WS] User ${userId} read message #${data.messageId} in ${roomName}`,
      );

      return { event: 'mark_as_read_success', data: updatedMessage };
    } catch (error) {
      console.error(`❌ [WS] Lỗi đánh dấu đã xem:`, error.message);

      client.emit('error_message', {
        message: 'Không thể đánh dấu đã xem: ' + error.message,
      });
    }
  }
}
