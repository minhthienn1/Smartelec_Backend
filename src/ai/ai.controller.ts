import { Controller, Post, Body, UseGuards, Req, Logger, BadRequestException } from '@nestjs/common';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);
  
  constructor(private readonly aiService: AiService) {}

  @UseGuards(JwtAuthGuard)
  @Post('chat')
  async chat(@Req() req, @Body() body: { message: string; image?: string; history?: any[] }) {
    // 1. Quét tìm ID từ nhiều kiểu JWT Payload khác nhau và ép sang Số
    const userId = Number(req.user?.id || req.user?.userId || req.user?.sub);

    // 2. Chặn lỗi từ vòng gửi xe nếu không có ID
    if (!userId || isNaN(userId)) {
      this.logger.error(`Lỗi JWT: Không tìm thấy userId trong req.user: ${JSON.stringify(req.user)}`);
      throw new BadRequestException('Lỗi xác thực: Không tìm thấy ID người dùng.');
    }

    // 3. Gọi Service như bình thường
    return this.aiService.chatWithAI(userId, body.message, body.image, body.history || []);
  }

  @UseGuards(JwtAuthGuard)
  @Post('feedback')
  async feedback(@Req() req, @Body() body: { sessionId: number; message: string; feedback: 'like' | 'dislike' }) {
    const userId = Number(req.user?.id || req.user?.userId || req.user?.sub);
    this.logger.log(`User ${userId} feedback [${body.feedback}] for session ${body.sessionId}: ${body.message.substring(0, 50)}...`);
    return { success: true, message: 'Cảm ơn bạn đã phản hồi!' };
  }
}
