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

import "./logger.scss";

import cn from "classnames";
import { memo, ReactNode } from "react";
import SyntaxHighlighter from "react-syntax-highlighter";
import { vs2015 as dark } from "react-syntax-highlighter/dist/esm/styles/hljs";
import { LiveAPIEvent } from "../../../aispeech/lib/live-api-client";
import {
  Content,
  LiveClientToolResponse,
  LiveServerContent,
  LiveServerToolCall,
  LiveServerToolCallCancellation,
  Part,
} from "@google/genai";

const formatTime = (d: Date) => d.toLocaleTimeString().slice(0, -3);

interface ClientContentLog {
  turns: Part[];
  turnComplete: boolean;
}

const LogEntry = memo(
  ({
    event,
    MessageComponent,
  }: {
    event: LiveAPIEvent;
    MessageComponent: ({ data }: { data: any }) => ReactNode;
  }): JSX.Element => (
    <li
      className={cn(
        `plain-log`,
        `source-${event.type.includes("client") ? "client" : "server"}`,
        {
          receive: !event.type.includes("client"),
          send: event.type.includes("client"),
        }
      )}
    >
      <span className="timestamp">{formatTime(event.timestamp)}</span>
      <span className="source">{event.type}</span>
      <span className="message">
        <MessageComponent data={event.data} />
      </span>
    </li>
  )
);

const PlainTextMessage = ({ data }: { data: any }) => (
  <span>{typeof data === "string" ? data : JSON.stringify(data)}</span>
);

const AnyMessage = ({ data }: { data: any }) => (
  <pre>{JSON.stringify(data, null, "  ")}</pre>
);

function tryParseCodeExecutionResult(output: string) {
  try {
    const json = JSON.parse(output);
    return JSON.stringify(json, null, "  ");
  } catch (e) {
    return output;
  }
}

const RenderPart = memo(({ part }: { part: Part }) => {
  if (part.text && part.text.length) {
    return <p className="part part-text">{part.text}</p>;
  }
  if (part.executableCode) {
    return (
      <div className="part part-executableCode">
        <h5>executableCode: {part.executableCode.language}</h5>
        <SyntaxHighlighter
          language={part.executableCode!.language!.toLowerCase()}
          style={dark}
        >
          {part.executableCode!.code!}
        </SyntaxHighlighter>
      </div>
    );
  }
  if (part.codeExecutionResult) {
    return (
      <div className="part part-codeExecutionResult">
        <h5>codeExecutionResult: {part.codeExecutionResult!.outcome}</h5>
        <SyntaxHighlighter language="json" style={dark}>
          {tryParseCodeExecutionResult(part.codeExecutionResult!.output!)}
        </SyntaxHighlighter>
      </div>
    );
  }
  if (part.inlineData) {
    return (
      <div className="part part-inlinedata">
        <h5>Inline Data: {part.inlineData?.mimeType}</h5>
      </div>
    );
  }
  return <div className="part part-unknown">&nbsp;</div>;
});

const ClientContentLog = memo(({ data }: { data: any }) => {
  const { turns, turnComplete } = data as ClientContentLog;
  const textParts = turns.filter((part) => !(part.text && part.text === "\n"));
  return (
    <div className="rich-log client-content user">
      <h4 className="roler-user">User</h4>
      <div key={`message-turn`}>
        {textParts.map((part, j) => (
          <RenderPart part={part} key={`message-part-${j}`} />
        ))}
      </div>
      {!turnComplete ? <span>turnComplete: false</span> : ""}
    </div>
  );
});

const ToolCallLog = memo(({ data }: { data: any }) => {
  const toolCall = data as LiveServerToolCall;
  return (
    <div className={cn("rich-log tool-call")}>
      {toolCall.functionCalls?.map((fc, i) => (
        <div key={fc.id} className="part part-functioncall">
          <h5>Function call: {fc.name}</h5>
          <SyntaxHighlighter language="json" style={dark}>
            {JSON.stringify(fc, null, "  ")}
          </SyntaxHighlighter>
        </div>
      ))}
    </div>
  );
});

const ToolCallCancellationLog = ({ data }: { data: any }): JSX.Element => (
  <div className={cn("rich-log tool-call-cancellation")}>
    <span>
      {" "}
      ids:{" "}
      {(data as LiveServerToolCallCancellation).ids?.map((id) => (
        <span className="inline-code" key={`cancel-${id}`}>
          "{id}"
        </span>
      ))}
    </span>
  </div>
);

const ToolResponseLog = memo(
  ({ data }: { data: any }): JSX.Element => (
    <div className={cn("rich-log tool-response")}>
      {(data as LiveClientToolResponse).functionResponses?.map((fc) => (
        <div key={`tool-response-${fc.id}`} className="part">
          <h5>Function Response: {fc.id}</h5>
          <SyntaxHighlighter language="json" style={dark}>
            {JSON.stringify(fc.response, null, "  ")}
          </SyntaxHighlighter>
        </div>
      ))}
    </div>
  )
);

const ModelTurnLog = ({ data }: { data: any }): JSX.Element => {
  const { modelTurn } = data as { modelTurn: Content };
  const { parts } = modelTurn;

  return (
    <div className="rich-log model-turn model">
      <h4 className="role-model">Model</h4>
      {parts
        ?.filter((part) => !(part.text && part.text === "\n"))
        .map((part, j) => (
          <RenderPart part={part} key={`model-turn-part-${j}`} />
        ))}
    </div>
  );
};

const CustomPlainTextLog = (msg: string) => () =>
  <PlainTextMessage data={msg} />;

export type LoggerFilterType = "conversations" | "tools" | "none";

export type LoggerProps = {
  filter: LoggerFilterType;
  events: LiveAPIEvent[];
};

const filters: Record<LoggerFilterType, (event: LiveAPIEvent) => boolean> = {
  tools: (event: LiveAPIEvent) =>
    event.type === "toolcall" ||
    event.type === "toolcallcancellation" ||
    event.type === "client-toolResponse",
  conversations: (event: LiveAPIEvent) =>
    event.type === "client-send" ||
    event.type === "content",
  none: () => true,
};

const component = (event: LiveAPIEvent) => {
  switch (event.type) {
    case "client-send":
      return ClientContentLog;
    case "toolcall":
      return ToolCallLog;
    case "toolcallcancellation":
      return ToolCallCancellationLog;
    case "client-toolResponse":
      return ToolResponseLog;
    case "content":
      return ModelTurnLog;
    case "interrupted":
      return CustomPlainTextLog("interrupted");
    case "turncomplete":
      return CustomPlainTextLog("turnComplete");
    case "open":
      return CustomPlainTextLog("Connected");
    case "close":
      return CustomPlainTextLog("Disconnected");
    case "error":
      return PlainTextMessage;
    case "setupcomplete":
      return CustomPlainTextLog("Setup Complete");
    // case "audio":
    //   return CustomPlainTextLog(`Audio buffer (${event.data?.byteLength || 0} bytes)`);
    // case "client-realtimeInput":
    //   return CustomPlainTextLog(`Sending ${event.data?.mediaType || "unknown"}`);
    default:
      return AnyMessage;
  }
};

export default function Logger({ filter = "none", events }: LoggerProps) {
  const filterFn = filters[filter];

  return (
    <div className="logger">
      <ul className="logger-list">
        {events.filter(filterFn).map((event, key) => {
          return (
            <LogEntry MessageComponent={component(event)} event={event} key={key} />
          );
        })}
      </ul>
    </div>
  );
}
