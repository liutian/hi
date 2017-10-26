
export class EventEmit {
  private listenerMap = new Map<string, any[]>();


  public on(eventName, listener) {
    let listeners = this.listenerMap.get(eventName);
    if (!listeners) {
      listeners = [];
      this.listenerMap.set(eventName, listeners);
    }
    if (listeners.includes(listener)) {
      throw new Error('repeat listener');
    }

    listeners.push(listener);
  }

  public off(eventName, listener?) {
    if (!listener) {
      this.listenerMap.delete(eventName);
    } else {
      const listeners = this.listenerMap.get(eventName);
      if (listeners && listeners.includes(listener)) {
        listeners.splice(listeners.indexOf(listener), 1);
      }
    }
  }

  public emit(eventName, ...arg) {
    if (this.listenerMap.has((eventName))) {
      const listeners = this.listenerMap.get(eventName);
      for (let i = 0; i < listeners.length; i++) {
        const listener = listeners[i];
        const isContinue = listener.apply(null, arg);
        if (isContinue === false) {
          break;
        }
      }
    }
  }


}
