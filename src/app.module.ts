import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WebRtcGateway } from './webrtc.gateway';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, WebRtcGateway],
})
export class AppModule { }
