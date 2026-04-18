import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Bật Validation (DTO)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  // Đọc PORT từ .env, nếu không có thì mặc định chạy 3000
  const port = process.env.PORT || 3000;

  await app.listen(port);
  console.log(`🚀 Server is running on: http://localhost:${port}`);
}
bootstrap();
