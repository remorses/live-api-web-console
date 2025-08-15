

import {
  Content,
  GoogleGenAI,
  LiveCallbacks,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerMessage,
  LiveServerToolCall,
  Part,
  Session,
  CallableTool,
  FunctionCall,
  MediaResolution,
} from "@google/genai";

import { difference } from "lodash";
import { LiveClientOptions } from "../types";
import { AudioStreamer } from "./audio-streamer";
import { AudioRecorder } from "./audio-recorder";
import { audioContext, base64ToArrayBuffer } from "./utils";
import VolMeterWorket from "./worklets/vol-meter";


export interface LiveAPIState {
  connected: boolean;
  muted: boolean;
  inVolume: number;
  outVolume: number;
  logs: string[];
  model: string;
  config: LiveConnectConfig;
}

export interface LiveAPIClientOptions extends LiveClientOptions {
  onStateChange?: (state: LiveAPIState) => void;
  tools?: CallableTool[];
}

export class LiveAPIClient {
  private client: GoogleGenAI;
  private session: Session | null = null;
  private audioStreamer: AudioStreamer | null = null;
  private audioRecorder: AudioRecorder | null = null;

  private state: LiveAPIState = {
    connected: false,
    muted: false,
    inVolume: 0,
    outVolume: 0,
    logs: [],
    model: "models/gemini-2.5-flash-preview-native-audio-dialog",
    config: {
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      contextWindowCompression: {
        triggerTokens: "25600",
        slidingWindow: { targetTokens: "12800" },
      },
    },
  };

  private onStateChange?: (state: LiveAPIState) => void;

  private tools: CallableTool[] = [];

  constructor(options: LiveAPIClientOptions) {
    const { onStateChange, tools, ...clientOptions } = options;
    this.client = new GoogleGenAI(clientOptions);
    this.onStateChange = onStateChange;
    this.tools = tools || [];

    this.audioRecorder = new AudioRecorder(16000);
    this.setupAudioRecorder();
  }

  // Method to update state and notify listeners
  private updateState(updates: Partial<LiveAPIState>) {
    this.state = { ...this.state, ...updates };
    this.onStateChange?.(this.state);
  }

  // Get a copy of the current state
  public getState(): LiveAPIState {
    return { ...this.state };
  }

  private async initAudioStreamer() {
    if (!this.audioStreamer) {
      const audioCtx = await audioContext({ id: "audio-out" });
      this.audioStreamer = new AudioStreamer(audioCtx);
      await this.audioStreamer.addWorklet<any>(
        "vumeter-out",
        VolMeterWorket,
        (ev: any) => {
          this.updateState({ outVolume: ev.data.volume });
        },
      );
    }
  }

  private setupAudioRecorder() {
    if (!this.audioRecorder) return;

    this.audioRecorder.on("data", (base64: string) => {
      if (this.state.connected && !this.state.muted) {
        this.sendRealtimeInput([
          {
            mimeType: "audio/pcm;rate=16000",
            data: base64,
          },
        ]);
      }
    });

    this.audioRecorder.on("volume", (volume: number) => {
      this.updateState({ inVolume: volume });
    });
  }

  private log(message: string) {

    const newEvents = [...this.state.logs, message];


    if (newEvents.length > 200) {
      this.updateState({ logs: newEvents.slice(-150) });
    } else {
      this.updateState({ logs: newEvents });
    }
  }

  async connect(model?: string, config?: LiveConnectConfig): Promise<boolean> {
    if (this.state.connected) {
      return false;
    }

    await this.initAudioStreamer();

    this.updateState({
      model: model || this.state.model,
      config: config || this.state.config,
    });

    const callbacks: LiveCallbacks = {
      onopen: this.onOpen.bind(this),
      onmessage: this.onMessage.bind(this),
      onerror: this.onError.bind(this),
      onclose: this.onClose.bind(this),
    };

    try {
      this.session = await this.client.live.connect({
        model: this.state.model,
        config: this.state.config,
        callbacks,
      });
    } catch (e) {
      console.error("Error connecting to GenAI Live:", e);
      this.log("error: " + JSON.stringify({ message: "Failed to connect", error: e }));
      return false;
    }

    return true;
  }

  disconnect() {
    if (!this.session) {
      return false;
    }

    this.session?.close();
    this.session = null;
    this.setConnected(false);

    this.audioRecorder?.stop();
    this.audioStreamer?.stop();

    this.log("close: " + JSON.stringify({ reason: "User disconnected" }));
    return true;
  }

  private setConnected(value: boolean) {
    this.updateState({ connected: value });

    if (value && !this.state.muted) {
      this.audioRecorder?.start();
    } else {
      this.audioRecorder?.stop();
    }
  }

  private onOpen() {
    this.setConnected(true);
    this.log("open");
  }

  private onError(e: ErrorEvent) {
    this.log("error: " + JSON.stringify({ message: e.message, error: e }));
  }

  private onClose(e: CloseEvent) {
    this.setConnected(false);
    this.log("close: " + JSON.stringify({ reason: e.reason, code: e.code }));
  }

  private async onMessage(message: LiveServerMessage) {
    if (message.setupComplete) {
      this.log("setupcomplete");
      return;
    }

    if (message.toolCall) {
      this.log("toolcall: " + JSON.stringify(message.toolCall));

      // Manually handle tool calls
      if (message.toolCall.functionCalls && this.tools.length > 0) {
        this.handleToolCalls(message.toolCall.functionCalls);
      }
      return;
    }

    if (message.toolCallCancellation) {
      this.log("toolcallcancellation: " + JSON.stringify(message.toolCallCancellation));
      return;
    }

    if (message.serverContent) {
      const { serverContent } = message;

      if (serverContent.interrupted) {
        this.log("interrupted");
        this.audioStreamer?.stop();
        return;
      }

      if (serverContent.turnComplete) {
        this.log("turncomplete");
      }

      if (serverContent.modelTurn) {
        let parts: Part[] = serverContent.modelTurn?.parts || [];

        const audioParts = parts.filter(
          (p) => p.inlineData && p.inlineData.mimeType?.startsWith("audio/pcm"),
        );
        const base64s = audioParts.map((p) => p.inlineData?.data);

        const otherParts = difference(parts, audioParts);

        base64s.forEach((b64) => {
          if (b64) {
            const data = base64ToArrayBuffer(b64);
            this.audioStreamer?.addPCM16(new Uint8Array(data));
            this.log("audio: " + JSON.stringify({ byteLength: data.byteLength }));
          }
        });

        if (otherParts.length) {
          this.log("content: " + JSON.stringify({ modelTurn: { parts: otherParts } }));
        }
      }
    }
  }

  setMuted(muted: boolean) {
    this.updateState({ muted });
    if (this.state.connected) {
      if (muted) {
        this.audioRecorder?.stop();
      } else {
        this.audioRecorder?.start();
      }
    }
  }

  sendText(text: string, turnComplete: boolean = true) {
    if (!this.session) return;

    const parts: Part[] = [{ text }];
    this.session.sendClientContent({ turns: parts, turnComplete });
    this.log("client-send: " + JSON.stringify({ turns: parts, turnComplete }));
  }

  sendRealtimeInput(chunks: Array<{ mimeType: string; data: string }>) {
    if (!this.session) return;

    let hasAudio = false;
    let hasVideo = false;

    for (const ch of chunks) {
      this.session.sendRealtimeInput({ media: ch });
      if (ch.mimeType.includes("audio")) {
        hasAudio = true;
      }
      if (ch.mimeType.includes("image")) {
        hasVideo = true;
      }
    }

    const mediaType = (() => {
      if (hasAudio && hasVideo) return "audio+video";
      if (hasAudio) return "audio";
      if (hasVideo) return "video";
      return "unknown";
    })();
    this.log("client-realtimeInput: " + JSON.stringify({ mediaType }));
  }

  private async handleToolCalls(functionCalls: FunctionCall[]) {
    if (!this.session || !this.tools.length) return;

    try {

      for (const tool of this.tools) {
        const parts = await tool.callTool(functionCalls);

        const functionResponses = parts
          .filter((part) => part.functionResponse)
          .map((part) => ({
            response: part.functionResponse!.response as Record<
              string,
              unknown
            >,
            id: part.functionResponse!.id,
            name: part.functionResponse!.name,
          }));

        if (functionResponses.length > 0) {
          this.session.sendToolResponse({ functionResponses });
          this.log("client-toolResponse: " + JSON.stringify({ functionResponses }));
        }
      }
    } catch (error) {
      console.error("Error handling tool calls:", error);
      this.log("error: " + JSON.stringify({ message: "Tool call failed", error }));
    }
  }

  setConfig(config: LiveConnectConfig) {
    if (config.tools) {
      this.tools = config.tools as CallableTool[];
    }
    this.updateState({ config });
  }

  setModel(model: string) {
    this.updateState({ model });
  }

  getConfig() {
    return { ...this.state.config };
  }

  destroy() {
    this.disconnect();
    this.audioRecorder?.stop();
    this.audioStreamer?.stop();
    this.tools = [];
  }
}
