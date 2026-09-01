import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from "@google/genai";
import type { RealtimeAdapter, RealtimeEvent, RealtimeSession } from "./types";

function floatToPcm16(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function resample(input: Float32Array, sourceRate: number, targetRate = 16_000) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    output[index] = input[Math.floor(index * ratio)];
  }
  return output;
}

export class GeminiRealtimeAdapter implements RealtimeAdapter {
  private listeners = new Set<(event: RealtimeEvent) => void>();
  private session?: Session;
  private audioContext?: AudioContext;
  private stream?: MediaStream;
  private worklet?: AudioWorkletNode;
  private playbackContext?: AudioContext;
  private playbackSources = new Set<AudioBufferSourceNode>();
  private nextPlaybackAt = 0;

  async connect(config: RealtimeSession) {
    if (!config.token) throw new Error("The Gemini session is missing an ephemeral token.");

    const client = new GoogleGenAI({ apiKey: config.token, apiVersion: "v1beta" });
    this.session = await client.live.connect({
      model: config.model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: {},
        contextWindowCompression: {
          triggerTokens: "25000",
          slidingWindow: { targetTokens: "8000" },
        },
      },
      callbacks: {
        onopen: () => this.emit({ type: "connected" }),
        onmessage: (message) => this.handleMessage(message),
        onerror: () => this.emit({ type: "error", message: "The Gemini Live connection failed." }),
        onclose: () => undefined,
      },
    });
  }

  sendText(text: string) {
    this.session?.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    });
  }

  async startMicrophone() {
    if (!this.session) throw new Error("Connect before starting the microphone.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    this.audioContext = new AudioContext();
    await this.audioContext.audioWorklet.addModule("/audio-capture-worklet.js");
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.audioContext, "pcm-capture");
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const data = floatToPcm16(resample(event.data, this.audioContext?.sampleRate ?? 48_000));
      this.session?.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } });
    };
    source.connect(this.worklet);
  }

  async stopMicrophone() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.worklet?.disconnect();
    await this.audioContext?.close();
    this.stream = undefined;
    this.worklet = undefined;
    this.audioContext = undefined;
  }

  interrupt() {
    this.session?.sendRealtimeInput({ audioStreamEnd: true });
    for (const source of this.playbackSources) source.stop();
    this.playbackSources.clear();
    this.nextPlaybackAt = 0;
    this.emit({ type: "interrupted" });
  }

  async close() {
    await this.stopMicrophone();
    for (const source of this.playbackSources) source.stop();
    this.playbackSources.clear();
    await this.playbackContext?.close();
    this.playbackContext = undefined;
    this.session?.close();
    this.session = undefined;
  }

  subscribe(listener: (event: RealtimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleMessage(message: LiveServerMessage) {
    const input = message.serverContent?.inputTranscription?.text;
    const output = message.serverContent?.outputTranscription?.text;
    if (input) this.emit({ type: "input-transcript", text: input, final: false });
    if (output) this.emit({ type: "output-transcript", text: output, final: false });
    if (message.serverContent?.interrupted) this.emit({ type: "interrupted" });
    if (message.serverContent?.turnComplete) this.emit({ type: "turn-complete" });
    for (const part of message.serverContent?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/pcm")) {
        this.playPcm24k(part.inlineData.data);
      }
    }
    if (message.usageMetadata) {
      this.emit({
        type: "usage",
        inputTokens: message.usageMetadata.promptTokenCount,
        outputTokens: message.usageMetadata.responseTokenCount,
      });
    }
  }

  private playPcm24k(encoded: string) {
    this.playbackContext ??= new AudioContext({ sampleRate: 24_000 });
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(Math.floor(bytes.length / 2));
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 0x8000;
    }
    const buffer = this.playbackContext.createBuffer(1, samples.length, 24_000);
    buffer.copyToChannel(samples, 0);
    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);
    const startsAt = Math.max(this.playbackContext.currentTime, this.nextPlaybackAt);
    this.nextPlaybackAt = startsAt + buffer.duration;
    this.playbackSources.add(source);
    source.onended = () => this.playbackSources.delete(source);
    source.start(startsAt);
  }

  private emit(event: RealtimeEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
