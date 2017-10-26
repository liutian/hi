import { Injectable, Inject, Optional } from '@angular/core';
import { Subject } from 'rxjs/Subject';

import { EventEmit } from './event-emit';


@Injectable()
export class PeerService extends EventEmit {
  // 可触发的事件：channelerror(messageChannel报错) message(messageChannel接收到消息)
  // sharemedia(对端请求共享媒体流) newmedia(新的对端媒体流加入) peerremove(对端连接移除)
  // receivedata(数据通道接收到数据)

  // 本地媒体流相关的属性
  public localMedia = {
    videoDeviceId: undefined,
    devices: null,
    status: 'stop',
    isMute: false,
    stream: null,
    startTime: 0,
    mediaMode: 'video',
    room: '',
    width: null,
    height: null,
    aspectRatio: undefined
  };
  // 当对端要发起offer时，携带的校验码，如果不一致则直接拒绝
  public readonly auth = this.random();
  // 对外建立对等连接时唯一标示
  private key: string;
  // 通过该对象来实现信令协商
  private socket;
  // 保存所有对等连接
  private peerMap = new Map<string, RTCPeerConnection>();
  // 只保存需要传输媒体流的对等连接
  private mediaPeerMap = new Map<string, RTCPeerConnection>();
  // 保存对等连接对应的校验码
  private peerAuthMap = new Map<string, string>();
  private fetchDataCallbackMap = new Map<string, any[]>();
  private sendMessageChannelMap = new Map<string, any>();
  private channelMessageBufferMap = new Map<string, any[]>();
  private icecandidateBufferMap = new Map<string, any[]>();
  private icecandidateBufferTimeoutMap = new Map<string, any>();
  // 配置选项
  private option: {
    peerConfig: any
  } | any;
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
    this.option = Object.assign({
      iceServers: [{
        urls: 'stun:stun.l.google.com:19302'
      }, {
        urls: 'stun:global.stun.twilio.com:3478?transport=udp'
      }
      ]
    }, option);
    socket.on('push', this.socketPushListener.bind(this));
  }

  public addData(dataId, data) {
    this.dataStore.set(dataId, data);
  }

  // 在某个房间中共享本地媒体信息
  public shareMediaStream(room) {
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

  // 主动从对端接收数据
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

  // 停止共享本地媒体信息
  public stopShareMediaStream() {
    this.localMedia.startTime = 0;
    this.closeMediaPeers();
    this.localMedia.status = 'stop';
  }

  public sendMessage(remoteKey, data) {
    let channel = this.sendMessageChannelMap.get(remoteKey);
    if (!channel) {
      channel = this.createMessageChannel(remoteKey);
      this.channelMessageBufferMap.get(remoteKey).push(data);
    } else if (channel.readyState === 'connecting') {
      this.channelMessageBufferMap.get(remoteKey).push(data);
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
  public getLocalMedia({ mediaMode, videoDeviceChange, aspectRatio, width, height }: any): Promise<MediaStream> {
    // 获取本地媒体流的同时获取本地媒体设备信息
    if (!this.localMedia.devices) {
      this.enumerateDevices();
    }
    if (this.localMedia.stream) {
      this.stopShareMediaStream();
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
    if (aspectRatio) {
      this.localMedia.aspectRatio = aspectRatio;
    }
    if (width) {
      this.localMedia.width = { ideal: width };
    }
    if (height) {
      this.localMedia.height = { ideal: height };
    }

    const constraints = this.createConstraints(this.localMedia.mediaMode, this.localMedia.videoDeviceId,
      this.localMedia.aspectRatio, this.localMedia.width, this.localMedia.height);
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
    this.stopShareMediaStream();
    Array.from(this.peerMap.keys()).forEach(key => {
      this.peerMap.get(key).close();
      this.removePeer(key);
    });
  }

  private createMessageChannel(remoteKey) {
    let peer = this.peerMap.get(remoteKey);
    if (!peer) {
      peer = this.createPeer(remoteKey);
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
    this.channelMessageBufferMap.set(remoteKey, []);
    channel.addEventListener('NetworkError', (e) => {
      this.emit('channelerror', e);
    });

    channel.addEventListener('TypeError', (e) => {
      this.emit('channelerror', e);
    });

    channel.addEventListener('open', () => {
      const messageBuffer = this.channelMessageBufferMap.get(remoteKey);
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

  private initSendData(channel, dataId?, offset?): Promise<undefined> {
    if (!this.isDataChannel(channel.label) || channel.label.split('-').length !== 3) {
      throw new Error('this is not transfer channel');
    }

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
          window.setTimeout(() => {
            channel.close();
            resolve();
          }, 1000);
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

  private receiveData(channel, remoteKey, fileId, channelSize) {
    let receiveBuffer = [];
    let currSize = 0;
    const [resolve, reject] = this.fetchDataCallbackMap.get(remoteKey + '-' + fileId);
    this.fetchDataCallbackMap.delete(remoteKey + '-' + fileId);
    const openTimeout = window.setTimeout(() => {
      reject(new Error('open timeout'));
    }, 10000);

    channel.addEventListener('open', (e) => {
      window.clearTimeout(openTimeout);
    });

    channel.addEventListener('message', (e) => {
      currSize += e.data.byteLength;
      this.emit('receivedata', {
        key: remoteKey,
        fileId: fileId,
        size: currSize,
        scale: currSize / channelSize
      });
      receiveBuffer.push(e.data);
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

    // const peer = this.peerMap.get(pushData.from);
    // // 如果发现自己是offer，则主动createOffer
    // if (peer && peer.localDescription.type === 'offer') {
    //   this.createOffer(pushData.from);
    // }
  }

  private socketPushListener(event) {
    const pushData = event.pushData;
    if (!pushData || !pushData.peer || (pushData.target && pushData.target !== this.key)) {
      return;
    }

    const peer = this.peerMap.get(pushData.from);
    if (pushData.type === 'preOffer') {// 接收到对端请求createOffer的请求
      if (pushData.channel === 'media') {// 只有媒体类型需要用户同意，数据块和数据流不需要
        this.emit('sharemedia', {
          agree: () => {
            this.agreeOffer(pushData);
          },
          key: pushData.from
        });
      } else {
        this.agreeOffer(pushData);
      }
    } else if (pushData.type === 'offerConfirm') {// 收到确认可以发起offer的请求
      this.startOffer(pushData);
    } else if (pushData.type === 'offer') {// 接收到offer
      if (pushData.auth !== this.auth) {
        console.error('auth invalid');
        return;
      }

      if (!peer) {
        this.createPeer(pushData.from);
      }
      this.createAnswer(pushData.from, pushData.data);
      if (pushData.channel === 'media') {
        this.emit('readyforsharemedia', {
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
      peer.close();
      this.removePeer(pushData.from);
    }
  }

  private closeMediaPeers() {
    Array.from(this.mediaPeerMap.keys()).forEach(key => {
      this.mediaPeerMap.get(key).close();
      this.removePeer(key);
      this.socket.push({// danger frequent
        pushData: {
          peer: true,
          type: 'closeMedia'
        }
      }, key);
    });
  }

  private startOffer(pushData) {
    if (pushData.channel === 'media' && (!this.localMedia.stream || this.localMedia.status !== 'sending')) {
      return;
    }

    let peer = this.peerMap.get(pushData.from);
    if (!peer) {
      peer = this.createPeer(pushData.from);
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

    // offer/answer 在peer创建之初就确定下来，如果是answer 即使是接收到 offerConfirm 也不createOffer, 对端的peer会主动createOffer
    // if (!peer.localDescription.type || peer.localDescription.type === 'offer') {
    this.createOffer(pushData.from, pushData.channel);
    // }
  }

  private createConstraints(mediaMode, videoDeviceId, aspectRatio, width, height) {
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
      if (aspectRatio) {
        constraints.video.aspectRatio = aspectRatio;
      }
      if (videoDeviceId) {
        constraints.video.deviceId = { exact: videoDeviceId };
      }
      if (width) {
        constraints.video.width = { exact: width };
      }
      if (height) {
        constraints.video.height = { exact: height };
      }
    } else if (mediaMode === 'audio') {
      constraints.video = false;
      constraints.audio = true;
    }

    return constraints;
  }

  // 发起Offer
  private createOffer(remoteKey: string, channel: string) {
    const peer = this.peerMap.get(remoteKey);
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
  private createAnswer(remoteKey: string, offer) {
    const peer = this.peerMap.get(remoteKey);
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
              data: answer
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
  private createPeer(remoteKey) {
    if (this.peerMap.has(remoteKey)) {
      return this.peerMap.get(remoteKey);
    }
    // 初始化peer实例
    const peer = new RTCPeerConnection(this.option.peerConfig);
    this.peerMap.set(remoteKey, peer);

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
      this.removePeer(remoteKey);
    });

    peer.addEventListener('iceconnectionstatechange', (e) => {
      // new , checking , connected , completed , failed , disconnected , closed
      console.log('peer iceconnectionstatechange : ' + peer.iceConnectionState);
      if (/(closed|failed)/ig.test(peer.iceConnectionState) && peer.signalingState !== 'closed') {
        peer.close();
        this.removePeer(remoteKey);
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
      this.removePeer(remoteKey);
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
          }
        }, remoteKey);
        icecandidateArr.length = 0;
      }, 1000);
      this.icecandidateBufferTimeoutMap.set(remoteKey, timeout);
    });

    // 监听地址变化事件
    peer.addEventListener('negotiationneeded', (e) => {// mark
      // console.info('negotiationneeded');
      // if (!peer.localDescription.sdp || peer.localDescription.type === 'offer') {
      //   this.createOffer(key);
      // } else if (peer.localDescription.type === 'answer') {
      //   this.createAnswer(key, peer.remoteDescription);
      // }
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

  private removePeer(key: string) {
    if (this.peerMap.has(key)) {
      const peer = this.peerMap.get(key);
      this.emit('peerremove', {
        key: key,
        peer: peer
      });
    }
    this.peerMap.delete(key);
    this.mediaPeerMap.delete(key);
    this.peerAuthMap.delete(key);
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
      if (kind === 'audio') {
        this.localMedia.stream.getAudioTracks().forEach(track => {
          peer.addTrack(track, this.localMedia.stream);
        });
      } else if (kind === 'video') {
        this.localMedia.stream.getVideoTracks().forEach(track => {
          peer.addTrack(track, this.localMedia.stream);
        });
      } else if (kind === undefined) {
        this.localMedia.stream.getTracks().forEach(track => {
          peer.addTrack(track, this.localMedia.stream);
        });
      }
    });
  }

  private random(): string {
    const number = Math.floor(Math.random() * 100000000);
    return Number.prototype.toString.call(number, 36);
  }
}
