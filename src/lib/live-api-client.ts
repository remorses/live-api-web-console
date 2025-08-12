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
  LiveClientToolResponse,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerMessage,
  LiveServerToolCall,
  LiveServerToolCallCancellation,
  Part,
  Session,
} from "@google/genai";

import { difference } from "lodash";
import { LiveClientOptions } from "../types";
import { AudioStreamer } from "./audio-streamer";
import { AudioRecorder } from "./audio-recorder";
import { audioContext, base64ToArrayBuffer } from "./utils";
import VolMeterWorket from "./worklets/vol-meter";

export interface LiveAPIEvent {
  type: 'open' | 'close' | 'error' | 'content' | 'audio' | 'toolcall' | 'toolcallcancellation' | 'interrupted' | 'turncomplete' | 'setupcomplete' | 'client-send' | 'client-realtimeInput' | 'client-toolResponse';
  timestamp: Date;
  data?: any;
}

export interface LiveAPIClientOptions extends LiveClientOptions {
  onVolumeChange?: (inVolume: number, outVolume: number) => void;
  onEventsChange?: () => void;
  onConnectionChange?: (connected: boolean) => void;
}

export class LiveAPIClient {
  private client: GoogleGenAI;
  private session: Session | null = null;
  private audioStreamer: AudioStreamer | null = null;
  private audioRecorder: AudioRecorder | null = null;
  public config: LiveConnectConfig = {};
  
  // Public state fields
  public connected: boolean = false;
  public muted: boolean = false;
  public model: string = "models/gemini-2.0-flash-exp";
  public events: LiveAPIEvent[] = [];
  public inVolume: number = 0;
  public outVolume: number = 0;
  
  // Callbacks for reactive updates
  private onVolumeChange?: (inVolume: number, outVolume: number) => void;
  private onEventsChange?: () => void;
  private onConnectionChange?: (connected: boolean) => void;
  
  // Tool handlers
  private toolHandlers: Map<string, (toolCall: LiveServerToolCall) => void> = new Map();

  constructor(options: LiveAPIClientOptions) {
    const { onVolumeChange, onEventsChange, onConnectionChange, ...clientOptions } = options;
    this.client = new GoogleGenAI(clientOptions);
    this.onVolumeChange = onVolumeChange;
    this.onEventsChange = onEventsChange;
    this.onConnectionChange = onConnectionChange;
    
    this.audioRecorder = new AudioRecorder(16000);
    this.setupAudioRecorder();
  }

  private async initAudioStreamer() {
    if (!this.audioStreamer) {
      const audioCtx = await audioContext({ id: "audio-out" });
      this.audioStreamer = new AudioStreamer(audioCtx);
      await this.audioStreamer.addWorklet<any>("vumeter-out", VolMeterWorket, (ev: any) => {
        this.outVolume = ev.data.volume;
        this.onVolumeChange?.(this.inVolume, this.outVolume);
      });
    }
  }

  private setupAudioRecorder() {
    if (!this.audioRecorder) return;
    
    this.audioRecorder.on("data", (base64: string) => {
      if (this.connected && !this.muted) {
        this.sendRealtimeInput([{
          mimeType: "audio/pcm;rate=16000",
          data: base64,
        }]);
      }
    });
    
    this.audioRecorder.on("volume", (volume: number) => {
      this.inVolume = volume;
      this.onVolumeChange?.(this.inVolume, this.outVolume);
    });
  }

  private addEvent(type: LiveAPIEvent['type'], data?: any) {
    const event: LiveAPIEvent = {
      type,
      timestamp: new Date(),
      data
    };
    this.events.push(event);
    
    // Keep events array reasonable size
    if (this.events.length > 200) {
      this.events = this.events.slice(-150);
    }
    
    this.onEventsChange?.();
  }

  async connect(model?: string, config?: LiveConnectConfig): Promise<boolean> {
    if (this.connected) {
      return false;
    }

    await this.initAudioStreamer();

    this.model = model || this.model;
    this.config = config || this.config;

    const callbacks: LiveCallbacks = {
      onopen: this.onOpen.bind(this),
      onmessage: this.onMessage.bind(this),
      onerror: this.onError.bind(this),
      onclose: this.onClose.bind(this),
    };

    try {
      this.session = await this.client.live.connect({
        model: this.model,
        config: this.config,
        callbacks,
      });
    } catch (e) {
      console.error("Error connecting to GenAI Live:", e);
      this.addEvent('error', { message: 'Failed to connect', error: e });
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
    
    this.addEvent('close', { reason: 'User disconnected' });
    return true;
  }

  private setConnected(value: boolean) {
    this.connected = value;
    this.onConnectionChange?.(value);
    
    if (value && !this.muted) {
      this.audioRecorder?.start();
    } else {
      this.audioRecorder?.stop();
    }
  }

  private onOpen() {
    this.setConnected(true);
    this.addEvent('open');
  }

  private onError(e: ErrorEvent) {
    this.addEvent('error', { message: e.message, error: e });
  }

  private onClose(e: CloseEvent) {
    this.setConnected(false);
    this.addEvent('close', { reason: e.reason, code: e.code });
  }

  private async onMessage(message: LiveServerMessage) {
    if (message.setupComplete) {
      this.addEvent('setupcomplete');
      return;
    }
    
    if (message.toolCall) {
      this.addEvent('toolcall', message.toolCall);
      
      // Call registered tool handlers
      for (const [, handler] of this.toolHandlers) {
        handler(message.toolCall);
      }
      return;
    }
    
    if (message.toolCallCancellation) {
      this.addEvent('toolcallcancellation', message.toolCallCancellation);
      return;
    }

    if (message.serverContent) {
      const { serverContent } = message;
      
      if ("interrupted" in serverContent) {
        this.addEvent('interrupted');
        this.audioStreamer?.stop();
        return;
      }
      
      if ("turnComplete" in serverContent) {
        this.addEvent('turncomplete');
      }

      if ("modelTurn" in serverContent) {
        let parts: Part[] = serverContent.modelTurn?.parts || [];

        // Handle audio parts
        const audioParts = parts.filter(
          (p) => p.inlineData && p.inlineData.mimeType?.startsWith("audio/pcm")
        );
        const base64s = audioParts.map((p) => p.inlineData?.data);

        // Strip audio parts from content
        const otherParts = difference(parts, audioParts);

        // Play audio
        base64s.forEach((b64) => {
          if (b64) {
            const data = base64ToArrayBuffer(b64);
            this.audioStreamer?.addPCM16(new Uint8Array(data));
            this.addEvent('audio', { byteLength: data.byteLength });
          }
        });

        // Add content event if there are non-audio parts
        if (otherParts.length) {
          this.addEvent('content', { modelTurn: { parts: otherParts } });
        }
      }
    }
  }

  // Public methods for interaction
  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.connected) {
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
    this.addEvent('client-send', { turns: parts, turnComplete });
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
    
    const mediaType = hasAudio && hasVideo ? "audio+video" : hasAudio ? "audio" : hasVideo ? "video" : "unknown";
    this.addEvent('client-realtimeInput', { mediaType });
  }

  sendToolResponse(toolResponse: LiveClientToolResponse) {
    if (!this.session) return;
    
    if (toolResponse.functionResponses && toolResponse.functionResponses.length) {
      this.session.sendToolResponse({
        functionResponses: toolResponse.functionResponses,
      });
      this.addEvent('client-toolResponse', toolResponse);
    }
  }

  // Register a tool handler
  registerToolHandler(id: string, handler: (toolCall: LiveServerToolCall) => void) {
    this.toolHandlers.set(id, handler);
  }

  unregisterToolHandler(id: string) {
    this.toolHandlers.delete(id);
  }

  // Update configuration
  setConfig(config: LiveConnectConfig) {
    this.config = config;
  }

  setModel(model: string) {
    this.model = model;
  }

  getConfig() {
    return { ...this.config };
  }

  // Clean up
  destroy() {
    this.disconnect();
    this.audioRecorder?.stop();
    this.audioStreamer?.stop();
    this.toolHandlers.clear();
  }
}