import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  HttpException,
  HttpStatus,
  Inject,
  forwardRef,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { MessageType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { ChatsGateway } from './chats.gateway';

@Injectable()
export class ChatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    @Inject(forwardRef(() => ChatsGateway))
    private readonly chatsGateway: ChatsGateway,
  ) {}

  // 0. LẤY DANH SÁCH PHIÊN CHAT CỦA USER (Hộp thư)
  async getUserSessions(userId: number) {
    try {
      return await this.prisma.chatSession.findMany({
        where: {
          OR: [{ userId: userId }, { technicianId: userId }],
          technicianId: { not: null }, // CHỈ HIỂN THỊ KHI ĐÃ CÓ THỢ NHẬN
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          user: { select: { id: true, fullName: true, avatarUrl: true, role: true } },
          technician: { select: { id: true, fullName: true, avatarUrl: true, role: true } },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { sender: { select: { id: true, fullName: true } } },
          },
        },
      });
    } catch (error) {
      throw new InternalServerErrorException('Lỗi khi tải danh sách phiên chat: ' + error.message);
    }
  }

  async getSessionById(sessionId: number) {
    return this.prisma.chatSession.findUnique({ where: { id: sessionId } });
  }

  // 1. LẤY DANH SÁCH TIN NHẮN (Cursor-based Pagination)
  async getMessages(sessionId: number, cursor?: number, limit: number = 20) {
    try {
      const messages = await this.prisma.message.findMany({
        where: { sessionId, isDeleted: false },
        take: limit,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'desc' },
        include: {
          sender: { select: { id: true, fullName: true, avatarUrl: true, role: true } },
        },
      });
      return messages.reverse();
    } catch (error) {
      throw new InternalServerErrorException('Lỗi khi tải tin nhắn: ' + error.message);
    }
  }

  // 2. GỬI TIN NHẮN
  async sendMessage(sessionId: number, senderId: number, dto: SendMessageDto) {
    try {
      const message = await this.prisma.message.create({
        data: {
          sessionId,
          senderId,
          type: dto.type,
          content: dto.content,
          metadata: dto.metadata ?? undefined,
        },
        include: {
          sender: { select: { id: true, fullName: true, avatarUrl: true, role: true } },
        },
      });

      // 3. Phát sự kiện qua Socket.io tới phòng chat để hiện tin nhắn ngay lập tức
      const roomName = `room_${sessionId}`;
      this.chatsGateway.server.to(roomName).emit('new_message', message);

      // Gửi Push Notification âm thầm
      this.triggerFCMNotification(sessionId, senderId, message).catch(err => 
        this.logger.error('Lỗi gửi FCM:', err.message)
      );

      return message;
    } catch (error) {
      throw new InternalServerErrorException('Lỗi khi gửi tin nhắn: ' + error.message);
    }
  }

  // 3. ĐÁNH DẤU TIN NHẮN ĐÃ XEM
  async markAsRead(messageId: number) {
    try {
      const message = await this.prisma.message.findUnique({ where: { id: messageId } });
      if (!message) throw new NotFoundException(`Không tìm thấy tin nhắn với ID = ${messageId}`);
      if (message.isRead) return message;

      return await this.prisma.message.update({
        where: { id: messageId },
        data: { isRead: true },
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Lỗi khi đánh dấu đã xem: ' + error.message);
    }
  }

  async markAllAsRead(sessionId: number, userId: number) {
    return this.prisma.message.updateMany({
      where: {
        sessionId: sessionId,
        senderId: { not: userId },
        isRead: false,
      },
      data: { isRead: true },
    });
  }

  // 4. HỆ THỐNG BÁO GIÁ (QUOTATION)
  async createQuote(sessionId: number, technicianId: number, dto: CreateQuoteDto) {
    const quote = await this.prisma.quote.create({
      data: { sessionId, technicianId, title: dto.title, amount: dto.amount },
    });

    const quoteMessage = await this.prisma.message.create({
      data: {
        sessionId,
        senderId: technicianId,
        type: 'QUOTE_CARD',
        content: `Báo giá mới cho: ${dto.title}`,
        metadata: { quoteId: quote.id, amount: dto.amount, title: dto.title, quoteStatus: 'PENDING' },
      },
      include: { sender: { select: { id: true, fullName: true, avatarUrl: true, role: true } } },
    });

    this.chatsGateway.emitToRoom(sessionId, 'new_message', quoteMessage);
    return { quote, message: quoteMessage };
  }

  async updateQuoteStatus(messageId: number, userId: number, status: 'ACCEPTED' | 'REJECTED') {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { session: true },
    });

    if (!message || message.type !== MessageType.QUOTE_CARD) {
      throw new NotFoundException('Không tìm thấy thẻ báo giá này.');
    }

    if (message.session.userId !== userId) {
      throw new ForbiddenException('Bạn không có quyền duyệt báo giá này!');
    }

    const metadata = message.metadata as Record<string, any>;
    const quoteId = metadata?.quoteId;

    const quote = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: status,
        ...(status === 'ACCEPTED' ? { acceptedAt: new Date() } : { rejectedAt: new Date() }),
      },
    });

    if (status === 'ACCEPTED') {
      await this.prisma.chatSession.update({
        where: { id: message.sessionId },
        data: { status: 'IN_PROGRESS' },
      });
      this.chatsGateway.emitToRoom(message.sessionId, 'job_status_changed', {
        sessionId: message.sessionId,
        status: 'IN_PROGRESS',
      });
    }

    const updatedMessage = await this.prisma.message.update({
      where: { id: messageId },
      data: { metadata: { ...metadata, quoteStatus: status } },
      include: { sender: { select: { id: true, fullName: true, avatarUrl: true, role: true } } },
    });

    this.chatsGateway.emitToRoom(message.sessionId, 'quote_updated', {
      messageId: messageId,
      status: status,
      message: updatedMessage,
    });

    return { quote, message: updatedMessage };
  }

  // 5. CHỐT ĐƠN ĐẶT THỢ (Transition to BROADCASTING)
  async bookTechnician(sessionId: number, userId: number) {
    const session = await this.prisma.chatSession.findUnique({ 
      where: { id: sessionId },
      include: { user: true }
    });
    if (!session) throw new NotFoundException(`Không tìm thấy phiên chat!`);
    if (session.userId !== userId) throw new BadRequestException('Bạn không có quyền chốt đơn này.');

    const updated = await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { status: 'BROADCASTING', updatedAt: new Date() },
    });

    this.chatsGateway.emitGlobal('new_broadcast_job', {
      sessionId: updated.id,
      deviceType: updated.deviceType,
      symptom: updated.symptom,
      aiSummary: updated.aiSummary,
      createdAt: updated.createdAt,
      version: updated.version,
      user: {
        id: session.userId,
        fullName: (session as any).user?.fullName || 'Khách hàng',
        avatarUrl: (session as any).user?.avatarUrl,
      },
    });

    return updated;
  }

  // 6. API CHO THỢ (JOB BOARD & ACCEPT)
  async getBroadcastJobs() {
    return this.prisma.chatSession.findMany({
      where: { status: 'BROADCASTING' },
      select: { 
        id: true, 
        deviceType: true, 
        symptom: true, 
        aiSummary: true, 
        createdAt: true, 
        version: true,
        user: { select: { id: true, fullName: true, avatarUrl: true } }
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acceptJob(sessionId: number, technicianId: number, currentVersion: number) {
    const result = await this.prisma.chatSession.updateMany({
      where: { id: sessionId, status: 'BROADCASTING', version: currentVersion },
      data: { status: 'MATCHED', technicianId: technicianId, version: { increment: 1 } },
    });

    if (result.count === 0) {
      throw new HttpException('Đơn này đã bị thợ khác nhận!', HttpStatus.CONFLICT);
    }

    await this.prisma.sessionAssignmentHistory.create({
      data: { chatSessionId: sessionId, technicianId: technicianId, action: 'ASSIGNED' },
    });

    this.chatsGateway.emitToRoom(sessionId, 'job_accepted', {
      sessionId,
      technicianId,
      status: 'MATCHED',
    });

    return { success: true, message: 'Nhận đơn thành công!' };
  }

  // Private Helper cho FCM
  private async triggerFCMNotification(sessionId: number, senderId: number, message: any) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, technicianId: true },
    });
    if (!session) return;

    const recipientId = senderId === session.userId ? session.technicianId : session.userId;
    if (!recipientId) return;

    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientId },
      select: { fcmToken: true, fullName: true },
    });
    if (!recipient || !recipient.fcmToken) return;

    const title = message.sender?.fullName || 'Tin nhắn mới';
    let body = message.content;
    if (message.type === MessageType.IMAGE) body = '📷 Đã gửi một ảnh';
    if (message.type === MessageType.QUOTE_CARD) body = '📄 Đã gửi báo giá mới';

    try {
      await this.notificationsService.sendTestNotification(recipient.fcmToken, title, body);
    } catch (err) {
      console.error('Lỗi gửi FCM:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // NHIỆM VỤ 1: CRON JOB - TỰ ĐỘNG HỦY ĐƠN SAU 30 PHÚT
  // ─────────────────────────────────────────────────────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async autoCancelStalledJobs() {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    const stalledSessions = await this.prisma.chatSession.findMany({
      where: {
        status: 'MATCHED',
        updatedAt: { lt: thirtyMinutesAgo },
      },
      include: {
        user: { select: { id: true, fullName: true, avatarUrl: true } },
      },
    });

    if (stalledSessions.length === 0) return;

    this.logger.log(`⏰ [CronJob] Tìm thấy ${stalledSessions.length} đơn quá hạn 30 phút, đang tự động hủy...`);

    for (const session of stalledSessions) {
      await this.prisma.chatSession.update({
        where: { id: session.id },
        data: {
          status: 'BROADCASTING',
          technicianId: null,
          version: { increment: 1 },
        },
      });

      // Ghi log lịch sử
      await this.prisma.sessionAssignmentHistory.create({
        data: {
          chatSessionId: session.id,
          technicianId: session.technicianId!,
          action: 'SYSTEM_AUTO_CANCEL',
        },
      });

      // Phát đơn lại cho tất cả thợ
      this.chatsGateway.emitGlobal('new_broadcast_job', {
        sessionId: session.id,
        deviceType: session.deviceType,
        symptom: session.symptom,
        aiSummary: session.aiSummary,
        createdAt: session.createdAt,
        version: session.version + 1,
        user: {
          id: session.userId,
          fullName: (session as any).user?.fullName || 'Khách hàng',
          avatarUrl: (session as any).user?.avatarUrl,
        },
      });

      // Thông báo cho phòng chat biết đơn đã bị hủy
      this.chatsGateway.emitToRoom(session.id, 'job_status_changed', {
        sessionId: session.id,
        status: 'BROADCASTING',
        reason: 'AUTO_CANCEL',
        message: 'Thợ không phản hồi trong 30 phút. Đơn đang được tìm thợ mới...',
      });

      this.logger.log(`✅ [CronJob] Đã tự động hủy và phát lại đơn #${session.id}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // NHIỆM VỤ 2: THỢ HỦY ĐƠN THỦ CÔNG
  // ─────────────────────────────────────────────────────────────────
  async cancelJob(sessionId: number, technicianId: number) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
    });

    if (!session) throw new NotFoundException('Không tìm thấy đơn hàng!');
    if (session.technicianId !== technicianId) {
      throw new ForbiddenException('Bạn không có quyền hủy đơn này!');
    }
    if (!['MATCHED', 'IN_PROGRESS'].includes(session.status)) {
      throw new BadRequestException('Chỉ có thể hủy đơn đang ở trạng thái MATCHED hoặc IN_PROGRESS.');
    }

    // Cập nhật lại trạng thái
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        status: 'BROADCASTING',
        technicianId: null,
        version: { increment: 1 },
      },
    });

    // Ghi lịch sử
    await this.prisma.sessionAssignmentHistory.create({
      data: {
        chatSessionId: sessionId,
        technicianId: technicianId,
        action: 'MANUAL_CANCEL',
      },
    });

    // Lấy version mới để phát đúng
    const updated = await this.prisma.chatSession.findUnique({ where: { id: sessionId } });

    // Phát đơn lại cho các thợ khác
    this.chatsGateway.emitGlobal('new_broadcast_job', {
      sessionId: session.id,
      deviceType: session.deviceType,
      symptom: session.symptom,
      aiSummary: session.aiSummary,
      createdAt: session.createdAt,
      version: updated!.version,
      user: {
        id: session.userId,
        fullName: (session as any).user?.fullName || 'Khách hàng',
        avatarUrl: (session as any).user?.avatarUrl,
      },
    });

    // Thông báo trong phòng chat
    this.chatsGateway.emitToRoom(sessionId, 'job_status_changed', {
      sessionId,
      status: 'BROADCASTING',
      reason: 'MANUAL_CANCEL',
      message: 'Thợ đã hủy đơn. Hệ thống đang tìm thợ mới cho bạn...',
    });

    return { success: true, message: 'Hủy đơn thành công!' };
  }

  // ─────────────────────────────────────────────────────────────────
  // NHIỆM VỤ 3: THỢ XÁC NHẬN HOÀN THÀNH ĐƠN
  // ─────────────────────────────────────────────────────────────────
  async completeJob(sessionId: number, technicianId: number) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) throw new NotFoundException('Không tìm thấy đơn hàng!');
    if (session.technicianId !== technicianId) {
      throw new ForbiddenException('Bạn không có quyền hoàn thành đơn này!');
    }
    if (session.status !== 'IN_PROGRESS') {
      throw new BadRequestException(
        `Chỉ có thể hoàn thành đơn ở trạng thái IN_PROGRESS. Trạng thái hiện tại: ${session.status}`,
      );
    }

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { status: 'COMPLETED' },
    });

    // Phát sự kiện vào phòng chat để khóa giao diện nhắn tin
    this.chatsGateway.emitToRoom(sessionId, 'job_completed', {
      sessionId,
      status: 'COMPLETED',
      message: '🎉 Đơn hàng đã hoàn thành! Cảm ơn bạn đã sử dụng SmartElec.',
    });

    return { success: true, message: 'Xác nhận hoàn thành đơn thành công!' };
  }

  // ─────────────────────────────────────────────────────────────────
  // NHIỆM VỤ 4: KHÁCH HÀNG GỬI ĐÁNH GIÁ SAU KHI HOÀN THÀNH
  // ─────────────────────────────────────────────────────────────────
  async submitReview(
    sessionId: number,
    userId: number,
    dto: { rating: number; comment?: string; tags?: string[] },
  ) {
    // [GUARD 1] Kiểm tra rating hợp lệ
    if (dto.rating < 1 || dto.rating > 5 || !Number.isInteger(dto.rating)) {
      throw new BadRequestException('Điểm đánh giá phải là số nguyên từ 1 đến 5.');
    }

    // [GUARD 2] Kiểm tra session tồn tại và đúng chủ
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: { review: true },
    });

    if (!session) {
      throw new NotFoundException('Không tìm thấy đơn hàng này.');
    }
    if (session.userId !== userId) {
      throw new ForbiddenException('Bạn không có quyền đánh giá đơn hàng này.');
    }
    if (session.status !== 'COMPLETED') {
      throw new BadRequestException(
        `Chỉ có thể đánh giá đơn đã hoàn thành. Trạng thái hiện tại: ${session.status}`,
      );
    }
    if (!session.technicianId) {
      throw new BadRequestException('Đơn hàng chưa có thợ phụ trách.');
    }

    // [GUARD 3] Kiểm tra đã đánh giá chưa (tránh spam)
    if (session.review) {
      throw new BadRequestException('Bạn đã gửi đánh giá cho đơn hàng này rồi.');
    }

    // [TRANSACTION] Tạo review và cập nhật cache điểm thợ trong 1 giao dịch
    const technicianId = session.technicianId;

    const [newReview] = await this.prisma.$transaction(async (tx) => {
      // Bước 1: Tạo bản ghi Review mới
      const review = await tx.review.create({
        data: {
          sessionId,
          userId,
          technicianId,
          rating: dto.rating,
          comment: dto.comment,
          tags: dto.tags ?? [],
        },
      });

      // Bước 2: Tính toán lại điểm trung bình sau khi thêm review mới
      const aggregate = await tx.review.aggregate({
        where: { technicianId },
        _avg: { rating: true },
        _count: { rating: true },
      });

      const newAvg = aggregate._avg.rating ?? dto.rating;
      const newCount = aggregate._count.rating;

      // Bước 3: Cập nhật cache điểm vào bảng User của thợ
      await tx.user.update({
        where: { id: technicianId },
        data: {
          averageRating: Math.round(newAvg * 10) / 10, // Làm tròn 1 chữ số thập phân
          totalReviews: newCount,
        },
      });

      this.logger.log(
        `⭐ [Review] Đơn #${sessionId} → Thợ #${technicianId} nhận đánh giá ${dto.rating}/5. Trung bình mới: ${newAvg.toFixed(1)} (${newCount} lượt)`,
      );

      return [review];
    });

    // Thông báo qua Socket cho thợ biết vừa nhận được đánh giá
    this.chatsGateway.emitToRoom(sessionId, 'review_submitted', {
      sessionId,
      rating: dto.rating,
      message: `Khách hàng đã đánh giá bạn ${dto.rating} sao!`,
    });

    return {
      success: true,
      message: 'Gửi đánh giá thành công! Cảm ơn bạn đã sử dụng SmartElec.',
      data: newReview,
    };
  }

  private readonly logger = new Logger(ChatsService.name);
}
