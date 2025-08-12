/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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

export interface LiveAPIEvent {
  type:
    | "open"
    | "close"
    | "error"
    | "content"
    | "audio"
    | "toolcall"
    | "toolcallcancellation"
    | "interrupted"
    | "turncomplete"
    | "setupcomplete"
    | "client-send"
    | "client-realtimeInput"
    | "client-toolResponse";
  timestamp: Date;
  data?: any;
}

export interface LiveAPIState {
  connected: boolean;
  muted: boolean;
  inVolume: number;
  outVolume: number;
  events: LiveAPIEvent[];
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

  // Internal state object
  private _state: LiveAPIState = {
    connected: false,
    muted: false,
    inVolume: 0,
    outVolume: 0,
    events: [],
    model: "models/gemini-2.5-flash-preview-native-audio-dialog",
    config: {
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      contextWindowCompression: {
        triggerTokens: "25600",
        slidingWindow: { targetTokens: "12800" },
      },
    },
  };

  // Public getters for state properties
  get connected() {
    return this._state.connected;
  }
  get muted() {
    return this._state.muted;
  }
  get inVolume() {
    return this._state.inVolume;
  }
  get outVolume() {
    return this._state.outVolume;
  }
  get events() {
    return this._state.events;
  }
  get model() {
    return this._state.model;
  }
  get config() {
    return this._state.config;
  }

  // Callback for state changes
  private onStateChange?: (state: LiveAPIState) => void;

  // Callable tools
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
    this._state = { ...this._state, ...updates };
    this.onStateChange?.(this._state);
  }

  // Get a copy of the current state
  public getState(): LiveAPIState {
    return { ...this._state };
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
      if (this._state.connected && !this._state.muted) {
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

  private addEvent(type: LiveAPIEvent["type"], data?: any) {
    const event: LiveAPIEvent = {
      type,
      timestamp: new Date(),
      data,
    };
    const newEvents = [...this._state.events, event];

    // Keep events array reasonable size
    if (newEvents.length > 200) {
      this.updateState({ events: newEvents.slice(-150) });
    } else {
      this.updateState({ events: newEvents });
    }
  }

  async connect(model?: string, config?: LiveConnectConfig): Promise<boolean> {
    if (this.connected) {
      return false;
    }

    await this.initAudioStreamer();

    this.updateState({
      model: model || this._state.model,
      config: config || this._state.config,
    });

    const callbacks: LiveCallbacks = {
      onopen: this.onOpen.bind(this),
      onmessage: this.onMessage.bind(this),
      onerror: this.onError.bind(this),
      onclose: this.onClose.bind(this),
    };

    try {
      this.session = await this.client.live.connect({
        model: this._state.model,
        config: this._state.config,
        callbacks,
      });
    } catch (e) {
      console.error("Error connecting to GenAI Live:", e);
      this.addEvent("error", { message: "Failed to connect", error: e });
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

    this.addEvent("close", { reason: "User disconnected" });
    return true;
  }

  private setConnected(value: boolean) {
    this.updateState({ connected: value });

    if (value && !this._state.muted) {
      this.audioRecorder?.start();
    } else {
      this.audioRecorder?.stop();
    }
  }

  private onOpen() {
    this.setConnected(true);
    this.addEvent("open");
  }

  private onError(e: ErrorEvent) {
    this.addEvent("error", { message: e.message, error: e });
  }

  private onClose(e: CloseEvent) {
    this.setConnected(false);
    this.addEvent("close", { reason: e.reason, code: e.code });
  }

  private async onMessage(message: LiveServerMessage) {
    if (message.setupComplete) {
      this.addEvent("setupcomplete");
      return;
    }

    if (message.toolCall) {
      this.addEvent("toolcall", message.toolCall);

      // Automatically handle tool calls with callable tools
      if (message.toolCall.functionCalls && this.tools.length > 0) {
        this.handleToolCalls(message.toolCall.functionCalls);
      }
      return;
    }

    if (message.toolCallCancellation) {
      this.addEvent("toolcallcancellation", message.toolCallCancellation);
      return;
    }

    if (message.serverContent) {
      const { serverContent } = message;

      if ("interrupted" in serverContent) {
        this.addEvent("interrupted");
        this.audioStreamer?.stop();
        return;
      }

      if ("turnComplete" in serverContent) {
        this.addEvent("turncomplete");
        // Signal to audio streamer that the turn is complete so it can flush remaining audio
        // this.audioStreamer?.complete();
      }

      if ("modelTurn" in serverContent) {
        let parts: Part[] = serverContent.modelTurn?.parts || [];

        // Handle audio parts
        const audioParts = parts.filter(
          (p) => p.inlineData && p.inlineData.mimeType?.startsWith("audio/pcm"),
        );
        const base64s = audioParts.map((p) => p.inlineData?.data);

        // Strip audio parts from content
        const otherParts = difference(parts, audioParts);

        // Play audio
        base64s.forEach((b64) => {
          if (b64) {
            const data = base64ToArrayBuffer(b64);
            this.audioStreamer?.addPCM16(new Uint8Array(data));
            this.addEvent("audio", { byteLength: data.byteLength });
          }
        });

        // Add content event if there are non-audio parts
        if (otherParts.length) {
          this.addEvent("content", { modelTurn: { parts: otherParts } });
        }
      }
    }
  }

  // Public methods for interaction
  setMuted(muted: boolean) {
    this.updateState({ muted });
    if (this._state.connected) {
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
    this.addEvent("client-send", { turns: parts, turnComplete });
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

    const mediaType =
      hasAudio && hasVideo
        ? "audio+video"
        : hasAudio
          ? "audio"
          : hasVideo
            ? "video"
            : "unknown";
    this.addEvent("client-realtimeInput", { mediaType });
  }

  // Handle tool calls automatically
  private async handleToolCalls(functionCalls: FunctionCall[]) {
    if (!this.session || !this.tools.length) return;

    try {
      // Execute all callable tools and collect responses
      const responseParts: Part[] = [];

      for (const tool of this.tools) {
        const parts = await tool.callTool(functionCalls);
        responseParts.push(...parts);
      }

      // Convert Parts to function responses
      if (responseParts.length > 0) {
        const functionResponses = responseParts
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
          this.addEvent("client-toolResponse", { functionResponses });
        }
      }
    } catch (error) {
      console.error("Error handling tool calls:", error);
      this.addEvent("error", { message: "Tool call failed", error });
    }
  }

  // Update configuration
  setConfig(config: LiveConnectConfig) {
    // Extract CallableTools from the config if provided
    if (config.tools) {
      this.tools = config.tools.filter(
        (tool): tool is CallableTool => 
          'callTool' in tool && typeof (tool as any).callTool === 'function'
      );
    }
    this.updateState({ config });
  }

  setModel(model: string) {
    this.updateState({ model });
  }

  getConfig() {
    return { ...this._state.config };
  }

  // Clean up
  destroy() {
    this.disconnect();
    this.audioRecorder?.stop();
    this.audioStreamer?.stop();
    this.tools = [];
  }
}
