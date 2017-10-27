import { Injectable, SimpleChanges } from '@angular/core';
import { Subject } from 'rxjs/Subject';
import { Observable } from 'rxjs/Observable';
import { Base64 } from 'js-base64';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import 'rxjs/add/operator/toPromise';

@Injectable()
export class SocketService {
  private separator = '$$';

  constructor(private http: HttpClient) { }

  getSocket({ serverUrl, connectPath, logicPath, namespace, secret, userid, uuid, platform = 'web', option = {} }): Promise<any> {
    const auth = Base64.encode(namespace + ':' + secret);
    let socketId;

    return new Promise((resovle, reject) => {
      const connectFn = () => {
        const url = serverUrl + namespace + '?userid=' + userid + '&uuid=' + uuid + '&platform=' + platform;
        const socket = window.io.connect(url, option);
        const key = userid + this.separator + uuid;
        socket.push = (data: { room?: string, pushData: any }, target?: string) => {
          const postData = Object.assign(data);
          postData.except = socketId;
          const headers = new HttpHeaders({
            Authorization: auth
          });

          if (target) {
            postData.room = this.parseUserRoom(target);
            postData.pushData.from = key;
            postData.pushData.target = target;
          }

          return this.http.post(serverUrl + logicPath + '/api/auth/push', postData, { headers }).toPromise();
        };

        socket.on('connect', () => {
          console.log('socket connect');
        });

        socket.on('ok', (data) => {
          resovle({ key: key, socket: socket });
          socketId = data.clientId;
        });

        socket.on('connect_error', (e) => {
          reject(e);
        });

        socket.on('connect_timeout', () => {
          reject(new Error('connect_timeout'));
        });
      };

      if (!window.io) {
        window.LazyLoad.js(serverUrl + connectPath + '/socket.io/socket.io.js', connectFn, null, this);
      } else {
        connectFn();
      }
    });
  }

  private parseUserRoom(key) {
    return 'user_' + key.split(this.separator)[0];
  }

  // joinRoom(rooms: string[], callback?) {
  //   this.socket.emit('joinRoom', rooms, callback);
  // }

  // leaveRoom(rooms: string[], callback?) {
  //   this.socket.emit('leaveRoom', rooms, callback);
  // }

  // getInfo(callback?) {
  //   this.socket.emit('info', {}, callback);
  // }

  // setInfo(data, callback?) {
  //   this.socket.emit('info', data, callback);
  // }

}
