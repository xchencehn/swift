export type ArchiveKind = 'jsonl' | 'sqlite' | null;
export interface ProviderCapabilities {
  id: string;
  archive: ArchiveKind;
  history: boolean;
  pagination: boolean;
  sync: boolean;
  send: boolean;
  stop: boolean;
  settings: boolean;
  questions: boolean;
  create: boolean;
  resume: boolean;
  terminalObserve: boolean;
  sessionFiles: boolean;
}

const unsupported: Readonly<ProviderCapabilities> = Object.freeze({
  id: '',
  archive: null,
  history: false,
  pagination: false,
  sync: false,
  send: false,
  stop: false,
  settings: false,
  questions: false,
  create: false,
  resume: false,
  terminalObserve: false,
  sessionFiles: false,
});
const readable = { history: true, pagination: true, sync: true, terminalObserve: true };
const controllable = {
  send: true,
  stop: true,
  settings: true,
  questions: true,
  create: true,
  resume: true,
  sessionFiles: true,
};
const definitions: readonly ProviderCapabilities[] = [
  { ...unsupported, ...readable, ...controllable, id: 'codex', archive: 'jsonl' },
  { ...unsupported, ...readable, ...controllable, id: 'claude', archive: 'jsonl' },
  ...['pi', 'omp', 'omo', 'gjc'].map((id) => ({
    ...unsupported,
    ...readable,
    id,
    archive: 'jsonl' as const,
  })),
  ...['opencode', 'devin'].map((id) => ({
    ...unsupported,
    ...readable,
    id,
    archive: 'sqlite' as const,
  })),
];
const registry = new Map(definitions.map((value) => [value.id, Object.freeze(value)]));
export const providers = Object.freeze(definitions.map((value) => value.id));
export const jsonlProviders = Object.freeze(
  definitions.filter((value) => value.archive === 'jsonl').map((value) => value.id),
);
export const databaseProviders = Object.freeze(
  definitions.filter((value) => value.archive === 'sqlite').map((value) => value.id),
);
export function get(provider: unknown): Readonly<ProviderCapabilities> {
  return registry.get(typeof provider === 'string' ? provider.toLowerCase() : '') || unsupported;
}
export function all(): readonly Readonly<ProviderCapabilities>[] {
  return [...registry.values()];
}
export function sessionKey(provider: unknown, sessionId: unknown): string {
  const capabilities = get(provider);
  return capabilities.sync && typeof sessionId === 'string' && sessionId
    ? `${capabilities.id}:${sessionId}`
    : '';
}
