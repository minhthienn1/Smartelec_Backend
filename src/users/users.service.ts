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
}
