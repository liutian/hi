import { Component, OnInit, ViewChild, ElementRef, OnDestroy } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

import { StoreService } from 'app/core/store.service';
import { SocketService } from 'module/rtc/socket.service';
import { PeerService } from 'module/rtc/peer.service';

@Component({
  selector: 'app-talk',
  templateUrl: './talk.component.html',
  styleUrls: ['./talk.component.scss']
})
export class TalkComponent implements OnInit, OnDestroy {

  room: string;
  roomList: string[] = [];
  messages: any[] = [];
  mediaList: string[] = [];
  userInfo: any;
  messageContent: string;
  sending = false;
  @ViewChild('file') file: ElementRef;

  private blobList = [];
  private socket: any;
  private userid: string;
  private fileId = 0;
  private fileIdPrefix: string;
  private fileMap = new Map();
  private socketKey: string;

  constructor(
    private domSanitizer: DomSanitizer,
    private peerService: PeerService,
    private socketService: SocketService,
    private storeService: StoreService) {
    this.userInfo = this.storeService.get('userInfo');

    if (!this.userInfo.userid) {
      this.userInfo.userid = this.userInfo.loginName;
      this.userInfo.uuid = Number.prototype.toString.call((Math.floor(Math.random() * 100000000)), 36);
      this.storeService.set('userInfo', this.userInfo);
    }

    this.fileIdPrefix = Number.prototype.toString.call(Math.floor(Math.random() * 10000000), 36);
    this.initSocket();

    this.peerService.on('peerremove', (e) => {
      if (this.mediaList.includes(e.key)) {
        this.mediaList.splice(this.mediaList.indexOf(e.key), 1);
      }
    });
  }

  ngOnInit() {
  }

  transferFile(e) {
    const file = this.file.nativeElement.files[0];
    if (!file) {
      return;
    }

    this.sending = true;
    const fileId = this.fileIdPrefix + ':' + (++this.fileId);
    this.fileMap.set(fileId, file);
    let contentType = 'file';
    if (/\.(jpg)|(png)|(gif)|(jpeg)$/.test(file.name)) {
      contentType = 'image';
    } else if (/\.(mp4)|(avi)$/.test(file.name)) {
      contentType = 'video';
    } else if (/\.(mp3)$/.test(file.name)) {
      contentType = 'audio';
    }

    const msg: any = {
      type: 'message',
      from: this.socketKey,
      contentType: contentType,
      mimeType: file.type,
      content: `${file.name}(${Math.floor(file.size / 1024)}M)`,
      fileId: fileId,
      fileSize: file.size,
      auth: this.peerService.auth
    };
    this.socket.push({
      room: this.room,
      pushData: msg
    }).then(() => {
      msg.download = true;
      msg.content = this.domSanitizer.bypassSecurityTrustUrl(window.URL.createObjectURL(file));
      this.messages.push(msg);
      this.peerService.addData(fileId, file);
      this.sending = false;
    });
  }

  send() {
    this.sending = true;
    const msg = {
      type: 'message',
      from: this.socketKey,
      contentType: 'text',
      content: this.messageContent
    };

    this.socket.push({
      room: this.room,
      pushData: msg
    }).then(() => {
      this.messages.push(msg);
      this.messageContent = '';
      this.sending = false;
    });
  }

  addRoom(room) {
    if (this.roomList.includes(room)) {
      return;
    }
    this.roomList.push(room);
    this.socket.emit('joinRoom', [room]);
    this.switchRoom(room);
  }

  switchRoom(room) {
    if (!this.roomList.includes(room)) {
      return;
    }
    this.room = room;
    this.messages = [];
    this.mediaList = [];
    this.peerService.closeAllPeer();
  }


  private initSocket() {
    this.socketService.getSocket({
      serverUrl: 'https://192.168.0.123',
      connectPath: '/push',
      logicPath: '/push-logic',
      namespace: '/visionet',
      secret: '123456',
      userid: this.userInfo.userid,
      uuid: this.userInfo.uuid,
      option: { path: '/push/socket.io' }
    }).then((data) => {
      this.socketKey = data.key;
      this.socket = data.socket;
      this.peerService.setup(data.key, data.socket);
      this.addRoom('hi');
      this.peerService.fetchMedia(this.room);

      this.peerService.on('sharemedia', (e) => {
        e.agree();
      });

      this.peerService.on('readyforsharemedia', (e) => {
        this.mediaList.push(e.key);
      });

      this.peerService.on('receivedata', (e) => {
        console.log('scale ' + e.scale);
      });

      this.peerService.on('message', (e) => {
        alert(e.message);
        this.peerService.sendMessage(e.key, '我是你妹');
      });

      this.socket.on('push', (e) => {
        if (e.pushData.type !== 'message') {
          return;
        }

        this.messages.push(e.pushData);
        if (e.pushData.contentType === 'image') {
          this.downloadImage(e.pushData);
        }
        this.peerService.sendMessage(e.pushData.from, '你是谁');
      });

    }, (e) => {
      alert('连接无法建立');
    });
  }

  private downloadImage(message) {
    this.peerService.fetchData(message.from, message.fileId, message.fileSize).then((data) => {
      const blob = new Blob(data, { type: message.mimeType });
      const blobUrl = window.URL.createObjectURL(blob);
      this.blobList.push(blobUrl);
      message.content = this.domSanitizer.bypassSecurityTrustUrl(blobUrl);
      message.download = true;
    });
  }

  ngOnDestroy() {
    this.blobList.forEach(blob => {
      window.URL.revokeObjectURL(blob);
    });
  }

}
