import { Module } from '@nestjs/common';
import { RedirController } from './redir.controller';

@Module({
  controllers: [RedirController],
})
export class RedirModule {}
