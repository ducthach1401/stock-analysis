import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { OgmaInterceptor, OgmaModule } from '@ogma/nestjs-module';
import { ExpressParser } from '@ogma/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { ScannerModule } from '../scanner/scanner.module';
import { SignalModule } from '../signal/signal.module';
import { StockModule } from '../stock/stock.module';
import { TelegramModule } from '../telegram/telegram.module';
import { PositionModule } from '../position/position.module';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { DerivativesModule } from '../derivatives/derivatives.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    OgmaModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const prod = config.get<string>('NODE_ENV') === 'production';
        const json =
          config.get<string>('LOG_JSON') === 'true' ||
          (prod && config.get<string>('LOG_JSON') !== 'false');
        return {
          application: 'stock-analysis',
          color: !json,
          json,
        };
      },
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      serveStaticOptions: { index: false },
      renderPath: '/',
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql',
        host: config.getOrThrow<string>('DB_HOST'),
        port: config.getOrThrow<number>('DB_PORT'),
        username: config.getOrThrow<string>('DB_USERNAME'),
        password: config.getOrThrow<string>('DB_PASSWORD'),
        database: config.getOrThrow<string>('DB_NAME'),
        autoLoadEntities: true,
        // Mặc định: sync khi không phải production. Production: đặt DB_SYNCHRONIZE=true
        // trong .env để TypeORM cập nhật schema theo entity khi khởi động app.
        synchronize: (() => {
          const explicit = config.get<string>('DB_SYNCHRONIZE');
          if (explicit === 'true') return true;
          if (explicit === 'false') return false;
          return config.get<string>('NODE_ENV') !== 'production';
        })(),
      }),
    }),
    ScheduleModule.forRoot(),
    AuthModule,
    TelegramModule,
    StockModule,
    SignalModule,
    PositionModule,
    WatchlistModule,
    ScannerModule,
    QueueModule,
    DerivativesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    ExpressParser,
    { provide: APP_INTERCEPTOR, useClass: OgmaInterceptor },
  ],
})
export class AppModule {}
