import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /auth/login
  @Post('login')
  login(@Body() body: { username: string; password: string }) {
    return this.authService.login(body.username, body.password);
  }

  // GET /auth/me — xác minh token còn hợp lệ
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Request() req: { user: { username: string } }) {
    return { username: req.user.username };
  }
}
