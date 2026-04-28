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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ChatsService } from './chats.service';
import { UploadService } from '../upload/upload.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { MessageType } from '@prisma/client';

@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chatsService: ChatsService,
    private readonly uploadService: UploadService,
  ) {}

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
  // Upload ảnh vào phiên chat → Lưu lên R2 → Tạo tin nhắn IMAGE
  // Client gửi: multipart/form-data, field name = 'file'
  // Tạm hardcode senderId = 3 (Khách hàng) để test
  // ─────────────────────────────────────────────────────────────────
  @Post(':id/image')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  async uploadImageMessage(
    @Param('id', ParseIntPipe) sessionId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    // Validate file
    if (!file) {
      throw new BadRequestException(
        'Không tìm thấy file. Vui lòng chọn ảnh để gửi.',
      );
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Loại file không hỗ trợ (${file.mimetype}). Chỉ chấp nhận: JPEG, PNG, WebP, GIF.`,
      );
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new BadRequestException(
        `File quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB). Tối đa: 5MB.`,
      );
    }

    // Bước 1: Upload ảnh lên Cloudflare R2
    const imageUrl = await this.uploadService.uploadFile(file, 'chat-images');

    // Bước 2: Tạo tin nhắn IMAGE với content = URL ảnh
    // TODO: Sau này lấy senderId từ JWT token (@Req() req → req.user.id)
    const senderId = 3; // Hardcode Khách hàng để test
    const message = await this.chatsService.sendMessage(sessionId, senderId, {
      type: MessageType.IMAGE,
      content: imageUrl,
      metadata: {
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
      },
    });

    return {
      message: 'Gửi ảnh thành công!',
      imageUrl,
      data: message,
    };
  }
}
