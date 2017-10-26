interface Window {
  LazyLoad: any;
  io: any;
  eruda: any;
  RTCDataChannel: any;
}

interface RTCPeerConnection {
  addTrack: Function;
  getSenders: Function;
  removeTrack: Function;
  connectionState: any;
  createDataChannel: Function;
}

interface Navigator {
  mediaDevices: any;
}