import { Controller, Get } from '@nestjs/common';
import { render } from 'nest-can-react';
import { PermPage, TempPage } from '../react-pages';

@Controller('redir')
export class RedirController {
  @Get('temp')
  temp() {
    return render(TempPage);
  }

  @Get('perm')
  perm() {
    return render(PermPage);
  }
}
