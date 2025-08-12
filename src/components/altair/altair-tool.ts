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
import vegaEmbed from "vega-embed";

export class AltairTool implements CallableTool {
  private container: HTMLDivElement | null = null;
  
  private declaration = {
    name: "render_altair",
    description: "Displays an altair graph in json format.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        json_graph: {
          type: Type.STRING,
          description:
            "JSON STRING representation of the graph to render. Must be a string, not a json object",
        },
      },
      required: ["json_graph"],
    },
  };

  constructor() {}

  setContainer(container: HTMLDivElement) {
    this.container = container;
  }

  async tool(): Promise<Tool> {
    return {
      functionDeclarations: [this.declaration]
    };
  }

  async callTool(functionCalls: FunctionCall[]): Promise<Part[]> {
    const parts: Part[] = [];
    
    for (const fc of functionCalls) {
      if (fc.name === this.declaration.name) {
        try {
          const jsonString = (fc.args as any).json_graph;
          
          if (this.container && jsonString) {
            // Render the Altair chart
            await vegaEmbed(this.container, JSON.parse(jsonString));
            
            parts.push({
              functionResponse: {
                name: fc.name,
                id: fc.id,
                response: { output: { success: true, message: "Chart rendered successfully" } }
              }
            });
          } else {
            parts.push({
              functionResponse: {
                name: fc.name,
                id: fc.id,
                response: { 
                  output: { 
                    success: false, 
                    message: this.container ? "Invalid JSON string" : "Container not set" 
                  } 
                }
              }
            });
          }
        } catch (error) {
          parts.push({
            functionResponse: {
              name: fc.name,
              id: fc.id,
              response: { 
                output: { 
                  success: false, 
                  message: `Error rendering chart: ${error}` 
                } 
              }
            }
          });
        }
      }
    }
    
    return parts;
  }
}