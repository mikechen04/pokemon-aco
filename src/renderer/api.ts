// Typed calls into the main process. Errors come back as plain, user-facing messages.
import { IPC_ERROR_PREFIX, type EventChannel, type EventContract, type InvokeChannel, type InvokeContract } from '../shared/ipc';

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const index = message.indexOf(IPC_ERROR_PREFIX);
  if (index >= 0) return message.slice(index + IPC_ERROR_PREFIX.length);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

export async function call<C extends InvokeChannel>(
  channel: C,
  ...args: Parameters<InvokeContract[C]>
): Promise<ReturnType<InvokeContract[C]>> {
  try {
    return await window.aco.invoke(channel, ...args);
  } catch (err) {
    throw new Error(cleanError(err));
  }
}

export function subscribe<E extends EventChannel>(channel: E, listener: (payload: EventContract[E]) => void): () => void {
  return window.aco.on(channel, listener);
}
