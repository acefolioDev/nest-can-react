import { Module } from '@nestjs/common';
import { NestReactModule } from 'nest-can-react';
import { HomeController } from './home.controller';
import { NotesModule } from './notes/notes.module';
import { RedirModule } from './redir/redir.module';
import { WelcomeModule } from './welcome/welcome.module';

@Module({
  controllers: [HomeController],
  imports: [NestReactModule.forRoot({ adapter: 'fastify' }), WelcomeModule, NotesModule, RedirModule],
})
export class AppModule {}
