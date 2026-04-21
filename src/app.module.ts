import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { ChatHistoryModule } from './chat-history/chat-history.module';
import { DevicesModule } from './devices/devices.module';

@Module({
  imports: [AuthModule, UsersModule, PrismaModule, ChatHistoryModule, DevicesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
