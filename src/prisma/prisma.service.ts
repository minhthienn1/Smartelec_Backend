import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private _device: any;
  public get device(): any {
    return this._device;
  }
  public set device(value: any) {
    this._device = value;
  }
  async onModuleInit() {
    await this.$connect(); // Kết nối với Neon khi app khởi động
  }
}
