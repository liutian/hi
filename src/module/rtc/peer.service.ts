import { Injectable, Inject, Optional } from '@angular/core';
import { Subject } from 'rxjs/Subject';

import { EventEmit } from './event-emit';


@Injectable()
export class PeerService extends EventEmit {
  // 可触发的事件：channelerror(messageChannel报错) message(messageChannel接收到消息)
  // sharemedia(对端请求主动共享媒体流) startmedia(准备接收对端的媒体流) newmedia(接收到对端的媒体流) stopmedia(移除媒体流)
  // receivedata(数据通道接收到数据)

  // 本地媒体流相关的属性
  public localMedia = {
    videoDeviceId: undefined, // 用于切换摄像头
    devices: null, // 通过遍历这个设备列表来实现切换摄像头的功能
    status: 'stop', // 标示当前是否在分享本地媒体流
    isMute: false, // 当前是否静音
    stream: null, // 本地媒体流对象
    startTime: 0, // 开始分享的时间
    mediaMode: 'video', // 分享模式：音视频/纯音频
    room: '', // 在哪个房间分享
  };
  // 当接收到对端发起offer时，携带的校验码要与auth一致否则直接拒绝，防止恶意请求
  public readonly auth = this.random();
  // 唯一标示，特征值
  private key: string;
  // 通过该对象来实现信令协商，建立对等连接之前的信息交换
  private socket;
  // 缓存非媒体流对等连接
  private nomediaPeerMap = new Map<string, RTCPeerConnection>();
  // 只缓存传输媒体流的对等连接
  private mediaPeerMap = new Map<string, RTCPeerConnection>();
  // 缓存对等连接对应的校验码，方便后续向对等连接发起offer
  private peerAuthMap = new Map<string, string>();
  // 请求对端发送指定数据时的回调函数，用来处理数据发送完成或者失败的回调
  private fetchDataCallbackMap = new Map<string, any[]>();
  // 缓存消息通道
  private sendMessageChannelMap = new Map<string, any>();
  // 缓存消息通道建立之前的需要发送出去的数据
  private messageChannelBufferMap = new Map<string, any[]>();
  // 缓存本地协商信息
  private icecandidateBufferMap = new Map<string, any[]>();
  private icecandidateBufferTimeoutMap = new Map<string, any>();
  // 配置选项
  private option: any = {
    iceServers: [{
      urls: 'stun:stun.l.google.com:19302'
    }, {
      urls: 'stun:global.stun.twilio.com:3478?transport=udp'
    }]
  };
  // 本地数据仓库
  private dataStore = new Map();
  private dataChannelPrefix = 'data';
  // 传输单个数据块的最大单位,该值不能过大否则通过数据通道发送大数据时，通道会直接关闭
  private minChunkSize = 1024 * 100;

  constructor() {
    super();
  }

  // 初始化
  public setup(key: string, socket: { on: Function, push: Function }, option = {}) {
    this.key = key;
    this.socket = socket;
    this.option = Object.assign(this.option, option);
    socket.on('push', this.socketPushListener.bind(this));
  }

  // 缓存数据块，便于发送数据块时直接查找
  public addData(dataId, data) {
    this.dataStore.set(dataId, data);
  }

  // 在某个房间中共享本地媒体信息
  public startMedia(room) {
    if (!room) {
      throw new Error('there no room');
    }
    // 必须保证本地媒体流已经就绪
    if (!this.localMedia.stream) {
      throw new Error('there no media stream');
    }

    this.localMedia.startTime = Date.now();
    this.localMedia.status = 'sending';
    this.localMedia.room = room;
    this.socket.push({
      room: room,
      pushData: {
        peer: true,
        type: 'preOffer',
        from: this.key,
        channel: 'media'
      }
    });
  }

  // 停止共享本地媒体信息
  public stopMedia() {
    this.localMedia.startTime = 0;
    this.localMedia.status = 'stop';
    this.localMedia.isMute = false;
    this.closeMediaPeers();
  }

  // 主动从对端接收数据，可断点续传
  public fetchData(remoteKey, dataId, size, offset = 0, channelConfig = {}): Promise<any[]> {
    this.socket.push({// danger frequent
      pushData: {
        peer: true,
        type: 'preOffer',
        channel: 'data',
        offset: offset,
        channelConfig: channelConfig,
        channelLabel: [this.dataChannelPrefix, dataId, offset].join('-'),
        channelSize: size
      }
    }, remoteKey);

    return new Promise((resolve, reject) => {
      this.fetchDataCallbackMap.set(remoteKey + '-' + dataId, [resolve, reject]);
    });
  }

  // 主动请求接收媒体流
  public fetchMedia(room) {
    this.socket.push({
      room: room,
      pushData: {
        peer: true,
        type: 'offerConfirm',
        from: this.key,
        channel: 'media',
        auth: this.auth
      }
    });
  }

  public sendMessage(remoteKey, data) {
    let channel = this.sendMessageChannelMap.get(remoteKey);
    if (!channel) {
      channel = this.createMessageChannel(remoteKey);
      this.messageChannelBufferMap.set(remoteKey, [data]);
    } else if (channel.readyState === 'connecting') {
      this.messageChannelBufferMap.get(remoteKey).push(data);
    } else if (channel.readyState === 'open') {
      channel.send(data);
    } else {
      throw new Error('channel readyState: ' + channel.readyState);
    }
  }

  // 设置本地语音是否静音
  public setMute(isMute) {
    this.localMedia.isMute = isMute;
    if (!this.localMedia.stream) {
      return;
    }

    this.localMedia.stream.getAudioTracks().forEach(track => {
      track.enabled = !isMute;
    });

    if (isMute) {
      this.removeMediaTracks('audio');
    } else {
      this.addMediaTracks('audio');
    }
  }

  // 获取本地摄像头，通过传递不同的参数来重新设置本地媒体流
  public getLocalMediaStream({ mediaMode, videoDeviceChange }: any): Promise<MediaStream> {
    // 获取本地媒体流的同时获取本地媒体设备信息
    if (!this.localMedia.devices) {
      this.enumerateDevices();
    }
    if (this.localMedia.stream) {
      this.stopMedia();
    }

    if (mediaMode) {
      this.localMedia.mediaMode = mediaMode;
    }
    // 无法通过facingMode自动选择摄像头，只能根据deviceId来确定
    if (videoDeviceChange) {
      const devices = this.localMedia.devices.videoinput;
      let index = devices.findIndex((device => {
        return device.deviceId === this.localMedia.videoDeviceId;
      }));

      if (index === -1) {
        index = 0;
      }
      this.localMedia.videoDeviceId = devices[(index + 1) % devices.length].deviceId;
    }

    const constraints = this.createConstraints(this.localMedia.mediaMode, this.localMedia.videoDeviceId);
    return navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
      this.localMedia.stream = stream;
      return stream;
    }).catch(e => {
      if (e.name === 'ConstraintNotSatisfiedError') {
        alert('设备无法满足要求');
      } else if (e.name === 'PermissionDeniedError') {
        alert('用户禁止获取本地媒体设备');
      }
    });
  }

  // 关闭所有对端连接
  public closeAllPeer() {
    this.stopMedia();
    Array.from(this.nomediaPeerMap.keys()).forEach(key => {
      this.nomediaPeerMap.get(key).close();
      this.removePeer(key);
    });
    this.nomediaPeerMap.clear();
    this.peerAuthMap.clear();
    this.icecandidateBufferMap.clear();
    this.icecandidateBufferTimeoutMap.forEach((timeout) => {
      window.clearTimeout(timeout);
    });
    this.icecandidateBufferTimeoutMap.clear();
  }

  private createMessageChannel(remoteKey) {
    let peer = this.nomediaPeerMap.get(remoteKey);
    if (!peer) {
      peer = this.createPeer(remoteKey, 'message');
      this.socket.push({
        pushData: {
          peer: true,
          type: 'preOffer',
          channel: 'message'
        }
      }, remoteKey);
    }
    const channel = peer.createDataChannel('message');
    channel.binaryType = 'arraybuffer';
    this.setMessageChannel(remoteKey, channel);
    return channel;
  }

  private setMessageChannel(remoteKey, channel) {

    this.sendMessageChannelMap.set(remoteKey, channel);
    this.messageChannelBufferMap.set(remoteKey, []);
    channel.addEventListener('NetworkError', (e) => {
      this.emit('channelerror', e);
    });

    channel.addEventListener('TypeError', (e) => {
      this.emit('channelerror', e);
    });

    channel.addEventListener('open', () => {
      const messageBuffer = this.messageChannelBufferMap.get(remoteKey);
      messageBuffer.forEach((message) => {
        channel.send(message);
      });
      messageBuffer.length = 0;
    });

    channel.addEventListener('message', (e) => {
      this.emit('message', {
        key: remoteKey,
        channel: channel,
        message: e.data
      });
    });
  }

  private isDataChannel(channelLabel) {
    return channelLabel.startsWith(this.dataChannelPrefix);
  }

  // 发送数据
  private initSendData(channel, dataId?, offset?): Promise<undefined> {
    if (!dataId) {
      dataId = channel.label.split('-')[1];
    }
    if (!offset) {
      offset = +channel.label.split('-')[2] || 0;
    }

    const data = this.dataStore.get(dataId);
    if (!data) {
      throw new Error('there no data');
    }

    channel.binaryType = 'arraybuffer';
    const chunkLength = Math.ceil(data / this.minChunkSize);

    return new Promise((resolve, reject) => {
      let reader = new FileReader();
      reader.addEventListener('load', (e: any) => {
        channel.send(e.target.result);
        offset += e.target.result.byteLength;
        if (offset < data.size) {
          const d = data.slice(offset, offset + this.minChunkSize);
          reader.readAsArrayBuffer(d);
        } else {
          reader.abort();
          reader = null;
          // 延迟1秒关闭连接，防止数据还未发送到对端
          // window.setTimeout(() => { // mark
          channel.close();
          resolve();
          // }, 1000);
        }
      });

      channel.addEventListener('error' , (e) => {
        reject(e);
      });

      channel.addEventListener('close' , (e) => {
        resolve(e);
      });

      channel.addEventListener('open', (e) => {
        const d = data.slice(offset, offset + this.minChunkSize);
        reader.readAsArrayBuffer(d);
      });

    });
  }

  // 接收数据
  private receiveData(channel, remoteKey, fileId, channelSize) {
    let receiveBuffer = [];
    let currSize = 0;
    const [resolve, reject] = this.fetchDataCallbackMap.get(remoteKey + '-' + fileId);
    this.fetchDataCallbackMap.delete(remoteKey + '-' + fileId);
    // 当超过指定时间还未开始数据接收则判定为操作失败
    const openTimeout = window.setTimeout(() => {
      reject(new Error('channel open timeout'));
    }, 10000);

    channel.addEventListener('open', (e) => {
      window.clearTimeout(openTimeout);
    });

    channel.addEventListener('message', (e) => {
      currSize += e.data.byteLength;
      receiveBuffer.push(e.data);
      this.emit('receivedata', {
        key: remoteKey,
        fileId: fileId,
        size: currSize,
        scale: currSize / channelSize
      });
      if (currSize >= channelSize) {
        resolve(receiveBuffer);
        receiveBuffer = null;
        channel.close();
      }
    });

    channel.addEventListener('error' , (e) => {
      receiveBuffer = null;
      reject(e);
    });

    channel.addEventListener('close' , (e) => {
      resolve(receiveBuffer);
      receiveBuffer = null;
    });
  }

  // 同意远程连接
  private agreeOffer(pushData) {
    this.socket.push({
      pushData: {
        peer: true,
        type: 'offerConfirm',
        auth: this.auth,
        channel: pushData.channel,
        channelConfig: pushData.channelConfig,
        channelLabel: pushData.channelLabel,
        offset: pushData.offset,
        channelSize: pushData.channelSize
      }
    }, pushData.from);
  }

  private socketPushListener(event) {
    const pushData = event.pushData;
    // 排除不相关的推送数据
    if (!pushData || !pushData.peer || (pushData.target && pushData.target !== this.key)) {
      return;
    }

    let peer = pushData.channel === 'media' ? this.mediaPeerMap.get(pushData.from) : this.nomediaPeerMap.get(pushData.from);
    if (pushData.type === 'preOffer') {// 对端请求主动建立连接
      if (pushData.channel === 'media') {// 只有媒体类型的对等数据传输需要用户同意，数据块和数据流不需要
        this.emit('sharemedia', {
          agree: () => {
            this.agreeOffer(pushData);
          },
          key: pushData.from
        });
      } else {
        this.agreeOffer(pushData);
      }
    } else if (pushData.type === 'offerConfirm') {// 对端同意建立对等连接
      this.startOffer(pushData);
    } else if (pushData.type === 'offer') {// 接收到offer
      if (pushData.auth !== this.auth) {
        console.error('auth invalid');
        return;
      }

      if (!peer) {
        peer = this.createPeer(pushData.from, pushData.channel);
      }
      this.createAnswer(pushData.from, pushData.data, pushData.channel);
      if (pushData.channel === 'media') {
        this.emit('startmedia', {
          key: pushData.from
        });
      }
    } else if (pushData.type === 'answer') { // 接收到answer
      if (!peer) {
        console.error('receive answer but there no peer');
        return;
      }

      peer.setRemoteDescription(pushData.data).then(() => {
        // console.info('setRemoteDescription answer success ');
      }).catch((e) => {
        console.error('setRemoteDescription answer error');
      });
    } else if (pushData.type === 'icecandidate') {// 接收到候选地址信息
      if (!peer) {
        console.error('receive icecandidate but there no peer');
        return;
      }

      pushData.data.forEach(icecandidate => {
        peer.addIceCandidate(icecandidate).then(() => {
          // console.info('addIceCandidate success');
        }).catch((e) => {
          console.error('addIceCandidate error' + e);
        });
      });
    } else if (pushData.type === 'closeMedia' && peer) {// 收到关闭对等连接的请求
      this.emit('stopmedia', {
        key: pushData.from,
        peer: peer
      });
      this.removePeer(pushData.from, 'media');
      peer.close();
    }
  }

  private closeMediaPeers() {
    Array.from(this.mediaPeerMap.keys()).forEach(key => {
      this.mediaPeerMap.get(key).close();
      this.removePeer(key, 'media');
      this.socket.push({// danger frequent
        pushData: {
          peer: true,
          type: 'closeMedia',
          channel: 'media'
        }
      }, key);
    });
    this.mediaPeerMap.clear();
  }

  // 创建offer前的准备工作
  private startOffer(pushData) {
    if (pushData.channel === 'media' && (!this.localMedia.stream || this.localMedia.status !== 'sending')) {
      return;
    }

    let peer = pushData.channel === 'media' ? this.mediaPeerMap.get(pushData.from) : this.nomediaPeerMap.get(pushData.from);
    if (!peer) {
      peer = this.createPeer(pushData.from, pushData.channel);
    }
    this.peerAuthMap.set(pushData.from, pushData.auth);

    if (pushData.channel === 'media') {
      this.mediaPeerMap.set(pushData.from, peer);
      // 清空原有的track
      peer.getSenders().forEach((sender) => {
        peer.removeTrack(sender);
      });
      // 首先将本地媒体流加入peer中，这一步很重要，必须在创建offer之前设置
      this.localMedia.stream.getTracks().forEach(track => {
        peer.addTrack(track, this.localMedia.stream);
      });
    } else if (pushData.channel === 'data') {// mark
      const channel = peer.createDataChannel(pushData.channelLabel, pushData.channelConfig || {});
      channel.binaryType = 'arraybuffer';
      this.receiveData(channel, pushData.from, pushData.channelLabel.split('-')[1], pushData.channelSize);
    }

    this.createOffer(pushData.from, pushData.channel);
  }

  private createConstraints(mediaMode, videoDeviceId) {
    const constraints: any = {
      video: {
        frameRate: 30
      },
      audio: {
        // autoGainControl: true,
        // echoCancellation: true,
        // noiseSuppression: true,
        // latency: 1,
        // sampleRate: 1,
        // sampleSize: 1,
        // volume: 1
      }
    };

    if (mediaMode === 'video') {
      if (videoDeviceId) {
        constraints.video.deviceId = { exact: videoDeviceId };
      }
    } else if (mediaMode === 'audio') {
      constraints.video = false;
      constraints.audio = true;
    }

    return constraints;
  }

  // 发起Offer
  private createOffer(remoteKey: string, channel: string) {
    const peer = channel === 'media' ? this.mediaPeerMap.get(remoteKey) : this.nomediaPeerMap.get(remoteKey);
    // 创建offer
    peer.createOffer().then((offer) => {
      // 将offer设置localDescription
      peer.setLocalDescription(offer).then(() => {
        // 发送offer
        this.socket.push({// danger frequent
          pushData: {
            peer: true,
            type: 'offer',
            data: offer, // json
            auth: this.peerAuthMap.get(remoteKey),
            channel: channel
          }
        }, remoteKey);
      }).catch((e) => {
        console.error('setLocalDescription error' + e);
      });
    }).catch((error) => {
      console.error(`remoteKey: ${remoteKey} createOffer fail: ${error}`);
    });
  }

  // 回复answer
  private createAnswer(remoteKey: string, offer, channel: string) {
    const peer = channel === 'media' ? this.mediaPeerMap.get(remoteKey) : this.nomediaPeerMap.get(remoteKey);
    // 首先将远程的offer设置为remoteDescription
    peer.setRemoteDescription(offer).then(() => {
      // 接着创建answer
      peer.createAnswer().then((answer) => {
        // 将answer设置为localDescription
        peer.setLocalDescription(answer).then(() => {
          // 发送answer
          this.socket.push({
            pushData: {
              peer: true,
              type: 'answer',
              data: answer,
              channel: channel
            }
          }, remoteKey);
        }).catch((e) => {
          console.error('setLocalDescription error' + e);
        });
      }).catch((error) => {
        console.error(`remoteKey: ${remoteKey} createAnswer fail : ${error}`);
      });
    }).catch((e) => {
      console.error('setRemoteDescription error' + e);
    });

  }

  // 建立和远端的对等链接
  private createPeer(remoteKey, channel) {
    // 初始化peer实例
    const peer = new RTCPeerConnection(this.option.peerConfig);
    channel === 'media' ? this.mediaPeerMap.set(remoteKey, peer) : this.nomediaPeerMap.set(remoteKey, peer);

    // 远程连接创建了一个数据通道
    peer.addEventListener('datachannel', (e: any) => {
      if (this.isDataChannel(e.channel.label)) {// 数据传输通道
        this.initSendData(e.channel);
      } else if (e.channel.label === 'message') {// 数据流通道
        this.setMessageChannel(remoteKey, e.channel);
      }
    });

    // 监听关闭事件
    peer.addEventListener('close', (e) => {
      this.removePeer(remoteKey, channel);
    });

    peer.addEventListener('iceconnectionstatechange', (e) => {
      // new , checking , connected , completed , failed , disconnected , closed
      console.log('peer iceconnectionstatechange : ' + peer.iceConnectionState);
      if (/(closed|failed)/ig.test(peer.iceConnectionState) && peer.signalingState !== 'closed') {
        peer.close();
        this.removePeer(remoteKey, channel);
      }
    });

    peer.addEventListener('icegatheringstatechange', (e) => {
      // new , gathering , complete
      console.log('peer icegatheringstatechange : ' + peer.iceGatheringState);
    });

    peer.addEventListener('signalingstatechange', (e) => {
      // stable , have-local-offer , have-remote-offer , have-local-pranswer , have-remote-pranswer
      console.log('peer signalingstatechange : ' + peer.signalingState);
    });

    peer.addEventListener('connectionstatechange', (e) => {
      // new , connection , connected , disconnected , failed , closed
      console.log('peer connectionState : ' + peer.connectionState);
    });

    // 监听异常报错事件
    peer.addEventListener('error', (e) => {
      console.error('peer error ' + e);
      this.removePeer(remoteKey, channel);
    });

    // 监听地址探测事件
    peer.addEventListener('icecandidate', (e) => {
      if (!e.candidate) { // mark
        return;
      }

      if (!this.icecandidateBufferMap.has(remoteKey)) {
        this.icecandidateBufferMap.set(remoteKey, []);
      }
      // 缓冲避免同时发送多个ajax请求
      this.icecandidateBufferMap.get(remoteKey).push(e.candidate);

      let timeout = this.icecandidateBufferTimeoutMap.get(remoteKey);
      window.clearTimeout(timeout);
      // 延迟1秒，避免 icecandidate 推送 比 offer 推送提前到达对端
      timeout = window.setTimeout(() => {
        // 将探测信息发送到对端
        const icecandidateArr = this.icecandidateBufferMap.get(remoteKey);
        this.socket.push({// danger frequent
          pushData: {
            peer: true,
            type: 'icecandidate',
            data: icecandidateArr,
            channel: channel
          }
        }, remoteKey);
        icecandidateArr.length = 0;
      }, 1000);
      this.icecandidateBufferTimeoutMap.set(remoteKey, timeout);
    });

    // 监听地址变化事件
    peer.addEventListener('negotiationneeded', (e) => {// mark
      // console.info('negotiationneeded');
    });

    // 监听对端音视频变化
    peer.addEventListener('track', (e: any) => {
      this.emit('newmedia', {
        key: remoteKey,
        peer: peer,
        stream: e.streams[0]
      });
    });

    return peer;
  }

  private removePeer(key: string, channel?: string) {
    const map = channel === 'media' ? this.mediaPeerMap : this.nomediaPeerMap;
    map.delete(key);
    if (channel !== 'media') {
      this.sendMessageChannelMap.delete(key);
      this.messageChannelBufferMap.delete(key);
    }
  }

  private removeMediaTracks(kind?) {
    Array.from(this.mediaPeerMap.keys()).forEach((key) => {
      const peer = this.mediaPeerMap.get(key);
      peer.getSenders().forEach((sender) => {
        if (kind) {
          if (kind === 'video' && sender.track.kind === 'video') {
            peer.removeTrack(sender);
          } else if (kind === 'audio' && sender.track.kind === 'audio') {
            peer.removeTrack(sender);
          }
        } else {
          peer.removeTrack(sender);
        }
      });
    });
  }

  private enumerateDevices() {
    return navigator.mediaDevices.enumerateDevices().then((deviceInfos) => {
      this.localMedia.devices = {
        audioinput: [],
        audiooutput: [],
        videoinput: []
      };

      deviceInfos.forEach(device => {
        if (device.kind === 'audioinput') {
          this.localMedia.devices.audioinput.push(device);
        } else if (device.kind === 'audiooutput') {
          this.localMedia.devices.audiooutput.push(device);
        } else if (device.kind === 'videoinput') {
          this.localMedia.devices.videoinput.push(device);
        }
      });

    });
  }

  private addMediaTracks(kind?) {
    Array.from(this.mediaPeerMap.keys()).forEach((key) => {
      const peer = this.mediaPeerMap.get(key);
      let tracks = [];
      if (kind === 'audio') {
        tracks = this.localMedia.stream.getAudioTracks();
      } else if (kind === 'video') {
        tracks = this.localMedia.stream.getVideoTracks();
      } else if (!kind) {
        tracks = this.localMedia.stream.getTracks();
      }

      tracks.forEach(track => {
        try {// 异常处理，防止在共享视频时提前静音然后共享后在取消静音导致的报错
          peer.addTrack(track, this.localMedia.stream);
        } catch (e) {
          console.log('add Track error ' + e);
        }
      });
    });
  }

  private random(): string {
    const number = Math.floor(Math.random() * 100000000);
    return Number.prototype.toString.call(number, 36);
  }
}
