// The only bridge between the UI and the main process: a typed invoke/on pair limited to
// the channels listed in shared/ipc.ts. No Node or Electron APIs are exposed to the page.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type AcoBridge } from '../shared/ipc';

const bridge: AcoBridge = {
  invoke: ((channel: string, ...args: unknown[]) => {
    if (!Object.hasOwn(INVOKE_CHANNELS, channel)) return Promise.reject(new Error(`Blocked channel: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  }) as AcoBridge['invoke'],
  on: ((channel: string, listener: (payload: unknown) => void) => {
    if (!Object.hasOwn(EVENT_CHANNELS, channel)) throw new Error(`Blocked channel: ${channel}`);
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  }) as AcoBridge['on'],
};

contextBridge.exposeInMainWorld('aco', bridge);
