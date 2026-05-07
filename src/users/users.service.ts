import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async updateFcmToken(userId: number, token: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: token },
    });
  }

  async toggleOnline(userId: number, lat?: number, lng?: number, isOnline?: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');
    
    return this.prisma.user.update({
      where: { id: userId },
      data: { 
        isOnline: isOnline !== undefined ? isOnline : !user.isOnline,
        lastLogin: new Date(), // Cập nhật thời điểm hoạt động cuối cùng
        ...(lat && { latitude: lat }),
        ...(lng && { longitude: lng }),
      },
    });
  }
}
