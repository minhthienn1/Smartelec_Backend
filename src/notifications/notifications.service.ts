import { Injectable, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as path from 'path';

@Injectable()
export class NotificationsService implements OnModuleInit {
  onModuleInit() {
    // Khởi tạo Firebase Admin
    const serviceAccountPath = path.join(process.cwd(), 'service-account.json');
    
    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountPath),
      });
      console.log('✅ Firebase Admin initialized thành công');
    } catch (error) {
      console.error('❌ Lỗi khởi tạo Firebase Admin:', error.message);
    }
  }

  async sendTestNotification(token: string, title: string, body: string) {
    const message = {
      notification: {
        title,
        body,
      },
      token: token,
      // Có thể thêm data payload ở đây nếu cần
      data: {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        type: 'test',
      },
    };

    try {
      const response = await admin.messaging().send(message);
      console.log('🚀 Gửi thông báo thành công:', response);
      return { success: true, messageId: response };
    } catch (error) {
      console.error('❌ Lỗi gửi thông báo:', error);
      throw error;
    }
  }
}
