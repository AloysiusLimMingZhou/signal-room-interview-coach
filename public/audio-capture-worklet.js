class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.pendingLength = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.pending.push(channel.slice());
      this.pendingLength += channel.length;
      if (this.pendingLength >= 1536) {
        const chunk = new Float32Array(this.pendingLength);
        let offset = 0;
        for (const block of this.pending) {
          chunk.set(block, offset);
          offset += block.length;
        }
        this.port.postMessage(chunk, [chunk.buffer]);
        this.pending = [];
        this.pendingLength = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
