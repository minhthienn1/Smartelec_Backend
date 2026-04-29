import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { MessageType } from '@prisma/client';

@Injectable()
export class ChatsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────
  // 1. LẤY DANH SÁCH TIN NHẮN (Cursor-based Pagination)
  // ─────────────────────────────────────────────────────────────────
  async getMessages(sessionId: number, cursor?: number, limit: number = 20) {
    try {
      const messages = await this.prisma.message.findMany({
        where: {
          sessionId,
          isDeleted: false,
        },
        take: limit,
        ...(cursor
          ? {
              skip: 1, // Bỏ qua bản ghi cursor hiện tại
              cursor: { id: cursor },
            }
          : {}),
        orderBy: { id: 'desc' },
        include: {
          sender: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
              role: true,
            },
          },
        },
      });

      // Lật ngược mảng: DB trả về mới→cũ, UI cần cũ→mới (trên xuống dưới)
      return messages.reverse();
    } catch (error) {
      throw new InternalServerErrorException(
        'Lỗi khi tải tin nhắn: ' + error.message,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. GỬI TIN NHẮN
  // ─────────────────────────────────────────────────────────────────
  async sendMessage(
    sessionId: number,
    senderId: number,
    dto: SendMessageDto,
  ) {
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
          sender: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
              role: true,
            },
          },
        },
      });

      return message;
    } catch (error) {
      throw new InternalServerErrorException(
        'Lỗi khi gửi tin nhắn: ' + error.message,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. TẠO BÁO GIÁ (QUOTE) + TỰ ĐỘNG GỬI TIN NHẮN QUOTE_CARD
  // ─────────────────────────────────────────────────────────────────
  async createQuote(
    sessionId: number,
    technicianId: number,
    dto: CreateQuoteDto,
  ) {
    // Kiểm tra session có tồn tại và technicianId có khớp không
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new BadRequestException(
        `Không tìm thấy phiên chat với ID = ${sessionId}`,
      );
    }

    if (session.technicianId !== technicianId) {
      throw new BadRequestException(
        'Bạn không phải thợ được gán cho ca sửa chữa này',
      );
    }

    try {
      // Dùng $transaction để đảm bảo tính toàn vẹn dữ liệu
      const result = await this.prisma.$transaction(async (tx) => {
        // Bước 1: Tạo bản ghi báo giá
        const quote = await tx.quote.create({
          data: {
            sessionId,
            technicianId,
            title: dto.title,
            amount: dto.amount,
            // status mặc định là PENDING (đã khai báo trong schema)
          },
        });

        // Bước 2: Tự động tạo tin nhắn QUOTE_CARD
        const message = await tx.message.create({
          data: {
            sessionId,
            senderId: technicianId,
            type: MessageType.QUOTE_CARD,
            content: 'Đã gửi báo giá mới',
            metadata: {
              quoteId: quote.id,
              title: quote.title,
              amount: quote.amount,
            },
          },
          include: {
            sender: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
                role: true,
              },
            },
          },
        });

        return { quote, message };
      });

      return result;
    } catch (error) {
      // Nếu là lỗi do mình ném (BadRequest) thì ném lại nguyên vẹn
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Lỗi khi tạo báo giá: ' + error.message,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 4. ĐÁNH DẤU TIN NHẮN ĐÃ XEM (mark_as_read)
  // ─────────────────────────────────────────────────────────────────
  async markAsRead(messageId: number) {
    try {
      // Kiểm tra tin nhắn có tồn tại không
      const message = await this.prisma.message.findUnique({
        where: { id: messageId },
      });

      if (!message) {
        throw new NotFoundException(
          `Không tìm thấy tin nhắn với ID = ${messageId}`,
        );
      }

      // Nếu đã đọc rồi thì không cần cập nhật lại
      if (message.isRead) {
        return message;
      }

      // Cập nhật isRead = true
      const updatedMessage = await this.prisma.message.update({
        where: { id: messageId },
        data: { isRead: true },
      });

      return updatedMessage;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Lỗi khi đánh dấu đã xem: ' + error.message,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 5. CẬP NHẬT TRẠNG THÁI BÁO GIÁ
  // ─────────────────────────────────────────────────────────────────
  async updateQuoteStatus(
    messageId: number,
    status: 'ACCEPTED' | 'REJECTED',
  ) {
    try {
      // Tìm tin nhắn chứa báo giá
      const message = await this.prisma.message.findUnique({
        where: { id: messageId },
      });

      if (!message || message.type !== MessageType.QUOTE_CARD) {
        throw new NotFoundException('Không tìm thấy thẻ báo giá này.');
      }

      const metadata = message.metadata as Record<string, any>;
      const quoteId = metadata?.quoteId;

      if (!quoteId) {
        throw new BadRequestException('Tin nhắn này không chứa mã báo giá hợp lệ.');
      }

      // Cập nhật trạng thái của Quote trong bảng quotes
      const quote = await this.prisma.quote.update({
        where: { id: quoteId },
        data: {
          status: status,
          ...(status === 'ACCEPTED' ? { acceptedAt: new Date() } : { rejectedAt: new Date() }),
        },
      });

      // Cập nhật metadata của Message để frontend dễ hiển thị
      const updatedMetadata = {
        ...metadata,
        quoteStatus: status,
      };

      const updatedMessage = await this.prisma.message.update({
        where: { id: messageId },
        data: { metadata: updatedMetadata },
        include: {
          sender: {
            select: { id: true, fullName: true, avatarUrl: true, role: true },
          },
        },
      });

      return { quote, message: updatedMessage };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException('Lỗi khi cập nhật báo giá: ' + error.message);
    }
  }
}
