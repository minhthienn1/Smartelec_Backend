import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  Patch,
  UseGuards,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatsService } from './chats.service';
import { UploadService } from '../upload/upload.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { MessageType } from '@prisma/client';
import { ChatsGateway } from './chats.gateway';

@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chatsService: ChatsService,
    private readonly uploadService: UploadService,
    private readonly chatsGateway: ChatsGateway,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // GET /chats
  // Lấy danh sách các phiên chat của user đang đăng nhập (Hộp thư)
  // ─────────────────────────────────────────────────────────────────
  @Get()
  @UseGuards(JwtAuthGuard)
  async getUserSessions(@Req() req) {
    const userId = req.user.userId;
    return this.chatsService.getUserSessions(userId);
  }

  // ─────────────────────────────────────────────────────────────────
  // GET /chats/:id/messages?cursor=10&limit=20
  // Lấy danh sách tin nhắn của phiên chat (Cursor-based Pagination)
  // ─────────────────────────────────────────────────────────────────
  @Get(':id/messages')
  async getMessages(
    @Param('id', ParseIntPipe) sessionId: number,
    @Query('cursor') cursorRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const cursor = cursorRaw ? parseInt(cursorRaw, 10) : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : 20;

    return this.chatsService.getMessages(sessionId, cursor, limit);
  }

  // ─────────────────────────────────────────────────────────────────
  // POST /chats/:id/messages
  // Gửi tin nhắn mới vào phiên chat
  // Tạm hardcode senderId = 3 (Khách hàng) để test
  // ─────────────────────────────────────────────────────────────────
  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @Param('id', ParseIntPipe) sessionId: number,
    @Body() dto: SendMessageDto,
  ) {
    // TODO: Sau này lấy senderId từ JWT token (@Req() req → req.user.id)
    const senderId = 3; // Hardcode Khách hàng để test
    return this.chatsService.sendMessage(sessionId, senderId, dto);
  }

  // ─────────────────────────────────────────────────────────────────
  // POST /chats/:id/quotes
  // Thợ tạo báo giá mới cho phiên chat
  // Tạm hardcode technicianId = 4 (Thợ) để test
  // ─────────────────────────────────────────────────────────────────
  @Post(':id/quotes')
  @HttpCode(HttpStatus.CREATED)
  async createQuote(
    @Param('id', ParseIntPipe) sessionId: number,
    @Body() dto: CreateQuoteDto,
  ) {
    // TODO: Sau này lấy technicianId từ JWT token (@Req() req → req.user.id)
    const technicianId = 4; // Hardcode Thợ để test
    return this.chatsService.createQuote(sessionId, technicianId, dto);
  }

  // ─────────────────────────────────────────────────────────────────
  // POST /chats/:id/image
  // Upload ảnh/video vào phiên chat → Lưu lên R2 → Tạo tin nhắn
  // ─────────────────────────────────────────────────────────────────
  @Post(':id/image')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  async uploadMediaMessage(
    @Param('id', ParseIntPipe) sessionId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Không tìm thấy file. Vui lòng chọn file để gửi.');
    }

    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
      'video/mp4', 'video/quicktime', 'video/x-matroska'
    ];
    
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Loại file không hỗ trợ (${file.mimetype}). Chỉ chấp nhận: Ảnh (JPEG, PNG, WebP, HEIC) và Video (MP4, MOV, MKV).`,
      );
    }

    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      throw new BadRequestException(
        `File quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB). Tối đa: 50MB.`,
      );
    }

    // Upload lên R2
    const fileUrl = await this.uploadService.uploadFile(file, 'chat-media');

    // Xác định MessageType dựa vào mimetype
    const type = file.mimetype.startsWith('video/') ? MessageType.VIDEO : MessageType.IMAGE;

    // TODO: Sau này lấy senderId từ JWT token (@Req() req → req.user.id)
    const senderId = 3; // Hardcode Khách hàng để test
    const message = await this.chatsService.sendMessage(sessionId, senderId, {
      type: type,
      content: fileUrl,
      metadata: {
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
      },
    });

    return {
      message: 'Gửi file thành công!',
      fileUrl,
      data: message,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // PATCH /chats/messages/:messageId/quote
  // Cập nhật trạng thái báo giá và emit qua socket
  // ─────────────────────────────────────────────────────────────────
  @Patch('messages/:messageId/quote')
  async updateQuoteStatus(
    @Param('messageId', ParseIntPipe) messageId: number,
    @Body('status') status: 'ACCEPTED' | 'REJECTED',
  ) {
    if (!['ACCEPTED', 'REJECTED'].includes(status)) {
      throw new BadRequestException('Trạng thái không hợp lệ.');
    }

    const { message } = await this.chatsService.updateQuoteStatus(messageId, status);

    // Emit event socket tới phòng chat
    const roomName = `room_${message.sessionId}`;
    this.chatsGateway.server.to(roomName).emit('quote_updated', {
      messageId: message.id,
      status: status,
      message: message, // Gửi luôn message mới nhất để frontend cập nhật
    });

    return {
      message: 'Đã cập nhật trạng thái báo giá thành công.',
      data: message,
    };
  }
}
