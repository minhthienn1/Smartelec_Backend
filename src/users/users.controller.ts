import { Controller, Patch, Body, UseGuards, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('fcm-token')
  @UseGuards(JwtAuthGuard)
  async updateFcmToken(@Req() req, @Body('token') token: string) {
    const userId = Number(req.user.sub || req.user.userId || req.user.id);
    return this.usersService.updateFcmToken(userId, token);
  }

  @Patch('toggle-online')
  @UseGuards(JwtAuthGuard)
  async toggleOnline(
    @Req() req,
    @Body('latitude') latitude?: number,
    @Body('longitude') longitude?: number,
    @Body('isOnline') isOnline?: boolean,
  ) {
    const userId = Number(req.user.sub || req.user.userId || req.user.id);
    return this.usersService.toggleOnline(userId, latitude, longitude, isOnline);
  }
}
