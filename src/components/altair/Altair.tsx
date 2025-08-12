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
import { useEffect, useRef, memo, useMemo } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { Modality, MediaResolution } from "@google/genai";
import { AltairTool } from "./altair-tool";
import { WeatherTool } from "../../lib/weather-tool";

function AltairComponent() {
  const client = useLiveAPIContext();
  const embedRef = useRef<HTMLDivElement>(null);
  
  // Create the Altair tool instance
  const altairTool = useMemo(() => new AltairTool(), []);

  useEffect(() => {
    // Set the container for the Altair tool when ref is ready
    if (embedRef.current) {
      altairTool.setContainer(embedRef.current);
    }
  }, [altairTool]);

  useEffect(() => {
    // Configure the model - using Google's recommended settings
    client.setModel("models/gemini-2.5-flash-preview-native-audio-dialog");
    
    // Set tools along with other config
    client.setConfig({
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {}, // transcribes your input speech
      outputAudioTranscription: {}, // transcribes the model's spoken audio
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
      },
      contextWindowCompression: {
        triggerTokens: "25600",
        slidingWindow: { targetTokens: "12800" },
      },
      systemInstruction: {
        parts: [
          {
            text: 'You are my helpful assistant. Any time I ask you for a graph call the "render_altair" function I have provided you. Dont ask for additional information just make your best judgement.',
          },
        ],
      },
      tools: [
        new WeatherTool(),
        altairTool,
      ],
    });
  }, [client, altairTool]);

  return <div className="vega-embed" ref={embedRef} />;
}

export const Altair = memo(AltairComponent);
