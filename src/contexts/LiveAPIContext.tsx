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

import { createContext, FC, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { LiveAPIClient, LiveAPIState } from "../lib/live-api-client";
import { LiveClientOptions } from "../types";

const LiveAPIContext = createContext<LiveAPIClient | undefined>(undefined);
const LiveAPIStateContext = createContext<LiveAPIState | undefined>(undefined);

export type LiveAPIProviderProps = {
  children: ReactNode;
  options: LiveClientOptions;
};

export const LiveAPIProvider: FC<LiveAPIProviderProps> = ({
  options,
  children,
}) => {
  const [clientState, setClientState] = useState<LiveAPIState | null>(null);

  const client = useMemo(() => {
    return new LiveAPIClient({
      ...options,
      onStateChange: (state) => setClientState(state),
    });
  }, [options]);

  useEffect(() => {
    // Initialize state
    setClientState(client.getState());

    return () => {
      client.destroy();
    };
  }, [client]);

  return (
    <LiveAPIContext.Provider value={client}>
      <LiveAPIStateContext.Provider value={clientState || client.getState()}>
        {children}
      </LiveAPIStateContext.Provider>
    </LiveAPIContext.Provider>
  );
};

export const useLiveAPIContext = () => {
  const context = useContext(LiveAPIContext);
  if (!context) {
    throw new Error("useLiveAPIContext must be used wihin a LiveAPIProvider");
  }
  return context;
};

export const useLiveAPIState = () => {
  const context = useContext(LiveAPIStateContext);
  if (!context) {
    throw new Error("useLiveAPIState must be used within a LiveAPIProvider");
  }
  return context;
};
