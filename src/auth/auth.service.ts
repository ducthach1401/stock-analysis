import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  private readonly adminUsername: string;
  private readonly adminPassword: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {
    this.adminUsername = this.config.getOrThrow<string>('ADMIN_USERNAME');
    this.adminPassword = this.config.getOrThrow<string>('ADMIN_PASSWORD');
  }

  login(username: string, password: string): { accessToken: string } {
    if (username !== this.adminUsername || password !== this.adminPassword) {
      throw new UnauthorizedException('Sai tên đăng nhập hoặc mật khẩu');
    }
    const payload = { sub: 'admin', username };
    return {
      accessToken: this.jwtService.sign(payload),
    };
  }
}
