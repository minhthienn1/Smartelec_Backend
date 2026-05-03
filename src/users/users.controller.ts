import { Controller, Patch, Body, UseGuards, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('fcm-token')
  @UseGuards(JwtAuthGuard)
  async updateFcmToken(@Req() req, @Body('token') token: string) {
    const userId = req.user.userId;
    return this.usersService.updateFcmToken(userId, token);
  }
}
