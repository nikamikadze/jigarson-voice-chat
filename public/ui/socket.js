export class RealtimeSocket {
  constructor({ sessionId, onEvent, params } = {}) {
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.params = params;
    this.ws = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = this.params ? `?${this.params.toString()}` : '';
    this.ws = new WebSocket(`${proto}//${location.host}/realtime${query}`);
    this.ws.onopen = () => this.send({ type: 'hello', sessionId: this.sessionId });
    this.ws.onmessage = (message) => this.onEvent(JSON.parse(message.data));
    this.ws.onclose = () => setTimeout(() => this.connect(), 800);
  }

  send(event) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  sendBinary(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }
}
