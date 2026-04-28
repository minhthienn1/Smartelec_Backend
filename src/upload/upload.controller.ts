import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  // ─────────────────────────────────────────────────────────────────
  // POST /upload/image
  // Upload ảnh lên Cloudflare R2 (dùng cho mọi nơi trong app)
  // Client gửi: multipart/form-data, field name = 'file'
  // ─────────────────────────────────────────────────────────────────
  @Post('image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Không tìm thấy file. Vui lòng chọn ảnh để upload.');
    }

    // Kiểm tra loại file (chỉ cho phép ảnh)
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Loại file không hỗ trợ (${file.mimetype}). Chỉ chấp nhận: JPEG, PNG, WebP, GIF.`,
      );
    }

    // Giới hạn dung lượng: 5MB
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new BadRequestException(
        `File quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB). Tối đa cho phép: 5MB.`,
      );
    }

    const url = await this.uploadService.uploadFile(file, 'chat-images');

    return {
      message: 'Upload ảnh thành công!',
      url,
    };
  }
}
