import { Controller, Post, UseInterceptors, UploadedFile, Body, UseGuards, Req, BadRequestException, Logger } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from '../upload/upload.service';
import { ChatsService } from './chats.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MessageType } from '@prisma/client';
import { extname } from 'path';

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly uploadService: UploadService,
    private readonly chatsService: ChatsService,
  ) {}

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadMedia(
    @UploadedFile() file: Express.Multer.File,
    @Body('sessionId') sessionId: string,
    @Req() req,
  ) {
    if (!file) {
      throw new BadRequestException('Không tìm thấy file upload.');
    }

    this.logger.log(`📁 Nhận file upload: ${file.originalname} | Mimetype: ${file.mimetype}`);

    // Xử lý fallback cho mimetype application/octet-stream (do Flutter/Android đôi khi không định danh được)
    let finalMimetype = file.mimetype;
    if (finalMimetype === 'application/octet-stream') {
      const ext = extname(file.originalname).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'];
      const videoExts = ['.mp4', '.mov', '.mkv', '.avi'];

      if (imageExts.includes(ext)) finalMimetype = 'image/' + (ext === '.jpg' ? 'jpeg' : ext.slice(1));
      if (videoExts.includes(ext)) finalMimetype = 'video/' + (ext === '.mov' ? 'quicktime' : ext.slice(1));
      
      this.logger.warn(`⚠️ Mimetype không xác định, sử dụng fallback từ extension: ${finalMimetype}`);
    }

    // 💣 Quả bom 2: Chặn file virus / sai định dạng & giới hạn dung lượng
    const isImage = finalMimetype.startsWith('image/');
    const isVideo = finalMimetype.startsWith('video/');

    if (!isImage && !isVideo) {
      throw new BadRequestException(`Định dạng file không hỗ trợ (${finalMimetype}). Chỉ chấp nhận Ảnh hoặc Video.`);
    }

    // Giới hạn dung lượng: Ảnh 10MB, Video 50MB
    const maxSize = isImage ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    if (file.size > maxSize) {
      const limitLabel = isImage ? '10MB' : '50MB';
      throw new BadRequestException(`File quá lớn. Giới hạn cho ${isImage ? 'Ảnh' : 'Video'} là ${limitLabel}.`);
    }

    // Gán lại mimetype chuẩn để R2 lưu đúng
    file.mimetype = finalMimetype;

    // 1. Upload lên Cloudflare R2
    const mediaUrl = await this.uploadService.uploadMediaToR2(file);
    const type = isVideo ? MessageType.VIDEO : MessageType.IMAGE;

    // 2. Lưu vào Database và Emit Socket (thông qua ChatsService)
    const senderId = Number(req.user.id || req.user.userId || req.user.sub);
    const message = await this.chatsService.sendMessage(Number(sessionId), senderId, {
      type: type,
      content: mediaUrl,
      metadata: {
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
      },
    });

    return { 
      success: true, 
      url: mediaUrl,
      type: type,
      data: message
    };
  }
}
