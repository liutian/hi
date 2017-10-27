import { Component, OnInit, Input, Inject, ViewChild, ElementRef, OnDestroy, OnChanges, SimpleChanges, AfterViewInit } from '@angular/core';
import { PeerService } from '../peer.service';

@Component({
  selector: 'app-rtc-remote',
  templateUrl: './rtc-remote.component.html',
  styleUrls: ['./rtc-remote.component.scss']
})
export class RtcRemoteComponent implements OnInit, OnDestroy, AfterViewInit {
  @Input() width: number;
  @Input() height: number;
  @Input() key: string;
  @ViewChild('remoteVideo') remoteVideo: ElementRef;
  boxFull = false;
  private peer: RTCPeerConnection;
  private audioEnable = true;
  private videoEnable = true;

  constructor(
    private peerService: PeerService,
  ) { }

  ngOnInit() {
    if (!this.key) {
      throw new Error('there no key');
    }
  }

  ngAfterViewInit() {
    this.peerService.on('newmedia', (e) => {
      if (e.key === this.key) {
        this.peer = e.peer;
        this.remoteVideo.nativeElement.srcObject = e.stream;
      }
    });
  }

  switchFullView($event, target) {
    if ($event.target === target || $event.target === this.remoteVideo.nativeElement) {
      this.boxFull = true;
    }
  }

  switchNormalView() {
    this.boxFull = false;
  }

  toggleAudio() {
    this.audioEnable = !this.audioEnable;
    this.peer.getRemoteStreams().forEach((stream) => {
      stream.getTracks().forEach((track) => {
        if (track.kind === 'audio') {
          track.enabled = this.audioEnable;
        }
      });
    });
  }

  toggleVideo() {
    this.videoEnable = !this.videoEnable;
    this.peer.getRemoteStreams().forEach((stream) => {
      stream.getTracks().forEach((track) => {
        if (track.kind === 'video') {
          track.enabled = this.videoEnable;
        }
      });
    });
  }

  ngOnDestroy() {
  }
}
