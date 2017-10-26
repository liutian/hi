import { NgModule } from '@angular/core';
import { WelcomeComponent } from './welcome/welcome.component';

import { RtcModule } from 'module/rtc/rtc.module';
import { ShareModule } from 'app/share/share.module';
import { RoutingModule } from 'app/home/routing/routing.module';
import { TalkComponent } from './talk/talk.component';


@NgModule({
  imports: [
    RtcModule,
    RoutingModule,
    ShareModule,
  ],
  declarations: [WelcomeComponent, TalkComponent]
})
export class HomeModule { }
