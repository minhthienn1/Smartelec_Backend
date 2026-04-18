import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  // 1. Chức năng Đăng ký
  async register(phoneNumber: string, pass: string) {
    // Kiểm tra SĐT đã tồn tại chưa
    const userExists = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (userExists) {
      throw new ConflictException('Số điện thoại này đã được đăng ký!');
    }

    // Băm mật khẩu (Mã hóa 1 chiều)
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(pass, salt);

    // Lưu User mới vào Database Neon
    const newUser = await this.prisma.user.create({
      data: {
        phoneNumber,
        password: hashedPassword,
      },
    });

    return {
      message: 'Đăng ký thành công!',
      userId: newUser.id,
    };
  }

  // 2. Chức năng Đăng nhập
  async login(phoneNumber: string, pass: string) {
    // Tìm user theo số điện thoại
    const user = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });

    // Nếu không tìm thấy user
    if (!user) {
      throw new UnauthorizedException('Số điện thoại hoặc mật khẩu không đúng');
    }

    // So sánh mật khẩu người dùng nhập với mật khẩu đã băm trong DB
    const isMatch = await bcrypt.compare(pass, user.password);

    if (!isMatch) {
      throw new UnauthorizedException('Số điện thoại hoặc mật khẩu không đúng');
    }

    // Tạo mã Token (Payload chứa các thông tin không nhạy cảm)
    const payload = {
      sub: user.id,
      phone: user.phoneNumber,
      role: user.role,
    };

    return {
      message: 'Đăng nhập thành công!',
      access_token: await this.jwtService.signAsync(payload),
      user: {
        id: user.id,
        phoneNumber: user.phoneNumber,
        fullName: user.fullName,
        role: user.role,
      },
    };
  }
}
