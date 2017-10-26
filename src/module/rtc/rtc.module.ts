import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import './lib/adapter';
import './lib/lazyload';

import { PeerService } from './peer.service';
import { SocketService } from './socket.service';
import { RtcLocalComponent } from './rtc-local/rtc-local.component';
import { RtcRemoteComponent } from './rtc-remote/rtc-remote.component';

@NgModule({
  imports: [
    CommonModule
  ],
  declarations: [
    RtcLocalComponent,
    RtcRemoteComponent
  ],
  providers: [
    PeerService,
    SocketService
  ],
  exports: [
    RtcRemoteComponent,
    RtcLocalComponent
  ],
  entryComponents: [
    RtcLocalComponent
  ]
})
export class RtcModule { }
