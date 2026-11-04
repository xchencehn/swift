import type WebSocket from 'ws';
export type { PaneInfo, SessionSnapshot, AgentSessionInfo } from './herdr-api.generated';
export interface TerminalAck {
  type: 'terminal.ack';
  streamId: string;
  offset: number;
}
export interface TerminalScreenAck {
  type: 'terminal.screen.ack';
  observerId: string;
  revision: number;
}
export interface TerminalFlow {
  type: 'terminal.flow';
  streamId: string;
  offset: number;
}
export interface TerminalHistoryRequest {
  type: 'terminal.history.request';
  requestId: string;
}
export interface TerminalHistory {
  type: 'terminal.history';
  requestId: string;
  available: boolean;
  text?: string;
  visible?: string;
}
// Terminal channel v1: each JSON event and input carries selectionId. Each
// binary frame begins with that same unsigned 32-bit little-endian number.
// A new selection starts with a complete native frame, followed by deltas.
export interface TerminalSelection {
  type: 'terminal.select';
  selectionId: number;
  target: {
    stateFormat?: 'cells-v1';
    runtimeId: string;
    paneId: string;
    terminalId: string;
    cols: number;
    rows: number;
  } | null;
}
export interface OutputControlOptions {
  ws: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;
  acknowledged: boolean;
  pause(): void;
  resume(): void;
  now?: () => number;
}
export interface WatchOptions {
  onFrame(data: string, frame?: { full: boolean; cols?: number; rows?: number }): void;
  onEnd(): void;
  onFull?(): void;
}
export interface TerminalSpan {
  text: string;
  color?: string;
  background?: string;
  inverse?: boolean;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}
export interface TerminalScreenSnapshot {
  type: 'terminal.screen';
  flow?: 'snapshot';
  requestId?: string;
  terminalId: string;
  binding: string;
  observerId: string;
  revision: number;
  capturedAt: number;
  cols: number;
  rows: TerminalSpan[][];
  projection: { recognized: boolean; rows: TerminalSpan[][]; statusRows: TerminalSpan[][] };
}

// Terminal channel v2 separates persistent subscriptions from foreground
// control. JSON and the uint32 binary prefix identify the subscription;
// input additionally carries the monotonic foreground selectionId.
export interface TerminalSubscription {
  type: 'terminal.subscribe';
  subscriptionId: number;
  target: NonNullable<TerminalSelection['target']>;
}
export interface TerminalActivation {
  type: 'terminal.activate';
  selectionId: number;
  subscriptionId: number | null;
}
export interface TerminalUnsubscribe {
  type: 'terminal.unsubscribe';
  subscriptionId: number;
}
export interface TerminalSubscriptionClosed {
  type: 'terminal.subscription.closed';
  subscriptionId: number;
  code: number;
  reason: string;
}
