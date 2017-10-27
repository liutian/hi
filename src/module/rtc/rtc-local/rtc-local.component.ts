import { Component, OnInit, Input, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';

import { PeerService } from '../peer.service';

@Component({
  selector: 'app-rtc-local',
  templateUrl: './rtc-local.component.html',
  styleUrls: ['./rtc-local.component.scss']
})
export class RtcLocalComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() mediaMode: string;
  @Input() room: string;
  @ViewChild('video') videoView: ElementRef;
  runTime = '00:00:00';
  localMedia: any;
  private timeout;


  constructor(
    private peerService: PeerService) { }

  ngOnInit() {
    this.localMedia = this.peerService.localMedia;
  }

  ngAfterViewInit() {
    this.videoView.nativeElement.muted = true;

    if ((this.room !== this.localMedia.room || this.mediaMode !== this.localMedia.mediaMode) && this.localMedia.stream) {
      this.peerService.stopMedia();
    }

    if (this.localMedia.stream) {
      this.videoView.nativeElement.srcObject = this.localMedia.stream;
    } else {
      this.peerService.getLocalMediaStream({ mediaMode: this.mediaMode }).then((stream) => {
        this.videoView.nativeElement.srcObject = stream;
      });
    }
  }

  toggleMute(mute) {
    this.peerService.setMute(mute);
  }

  toggleFacingMode() {
    if (this.localMedia.status === 'sending') {
      this.stop();
    }
    this.peerService.getLocalMediaStream({ videoDeviceChange: true }).then((stream: MediaStream) => {
      this.videoView.nativeElement.srcObject = stream;
    });
  }

  toggleMediaMode(mediaMode) {
    if (this.localMedia.status === 'sending') {
      this.stop();
    }
    this.peerService.getLocalMediaStream({ mediaMode: mediaMode }).then((stream: MediaStream) => {
      this.videoView.nativeElement.srcObject = stream;
    });
  }

  run() {
    this.peerService.startMedia(this.room);
    this.timeout = setInterval(() => {
      this.runTime = this.calcRunTime();
    }, 1000);
  }

  stop() {
    clearInterval(this.timeout);
    this.runTime = '00:00:00';
    this.peerService.stopMedia();
  }

  calcRunTime() {
    const diff = (Date.now() - this.localMedia.startTime) / 1000;
    const seconds = Math.floor(diff % 60) + '';
    const minutes = Math.floor((diff % 3600) / 60) + '';
    const hours = Math.floor(diff / 3600) + '';
    return hours.padStart(2, '00') + ':' + minutes.padStart(2, '00') + ':' + seconds.padStart(2, '00');
  }

  ngOnDestroy() {
    clearInterval(this.timeout);
    this.videoView.nativeElement.srcObject = null;
  }
}
