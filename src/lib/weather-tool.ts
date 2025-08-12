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

import { CallableTool, FunctionCall, Part, Tool, Type } from "@google/genai";

export class WeatherTool implements CallableTool {
  private declaration = {
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: {
          type: Type.STRING,
          description: "The city and state, e.g. San Francisco, CA",
        },
        unit: {
          type: Type.STRING,
          description: "The unit system for temperature",
          enum: ["celsius", "fahrenheit"],
        },
      },
      required: ["location"],
    },
  };

  async tool(): Promise<Tool> {
    return {
      functionDeclarations: [this.declaration]
    };
  }

  async callTool(functionCalls: FunctionCall[]): Promise<Part[]> {
    const parts: Part[] = [];
    
    for (const fc of functionCalls) {
      if (fc.name === this.declaration.name) {
        const location = (fc.args as any).location || "Unknown";
        const unit = (fc.args as any).unit || "fahrenheit";
        
        // Hardcoded weather data
        const weatherData = {
          "San Francisco, CA": { temp: 65, condition: "Partly Cloudy", humidity: 68 },
          "New York, NY": { temp: 72, condition: "Sunny", humidity: 55 },
          "London, UK": { temp: 58, condition: "Rainy", humidity: 85 },
          "Tokyo, Japan": { temp: 78, condition: "Clear", humidity: 62 },
          "Paris, France": { temp: 61, condition: "Cloudy", humidity: 70 },
          "default": { temp: 70, condition: "Clear", humidity: 60 }
        };
        
        const data = weatherData[location as keyof typeof weatherData] || weatherData.default;
        
        // Convert temperature if needed
        const temperature = unit === "celsius" 
          ? Math.round((data.temp - 32) * 5/9)
          : data.temp;
        
        const unitSymbol = unit === "celsius" ? "°C" : "°F";
        
        parts.push({
          functionResponse: {
            name: fc.name,
            id: fc.id,
            response: {
              weather: {
                location,
                temperature: `${temperature}${unitSymbol}`,
                condition: data.condition,
                humidity: `${data.humidity}%`,
                forecast: "Stable conditions expected for the next 24 hours"
              }
            }
          }
        });
      }
    }
    
    return parts;
  }
}