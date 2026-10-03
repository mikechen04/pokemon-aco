// Desktop notifications and the optional Discord webhook.
// Messages never include account emails, passwords or full addresses.
import { Notification, net, type NativeImage } from 'electron';
import { DISCORD_WEBHOOK_PATTERN } from '../../shared/constants';
import { formatUsd } from '../../shared/money';
import { RETAILERS } from '../../shared/retailers';
import type { ActionResult, NotifyOn, RetailerId, Settings } from '../../shared/types';
import { logBus } from './logger';
import { redact } from './redact';

export type NotifyKind = keyof NotifyOn;

export interface NotifyEvent {
  kind: NotifyKind;
  title: string;
  detail: string;
  retailer: RetailerId;
  taskLabel: string;
  productUrl?: string;
  imageUrl?: string;
  price?: number;
  quantity?: number;
  profileName?: string;
  orderNumber?: string;
}

const COLORS: Record<NotifyKind, number> = {
  inStock: 0x5eead4,
  queue: 0xfbbf24,
  carted: 0xf9a8d4,
  checkedOut: 0x4ade80,
  paused: 0xfb923c,
  failed: 0xf87171,
};

interface DiscordPayload {
  username: string;
  allowed_mentions: { parse: string[] };
  embeds: Array<Record<string, unknown>>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Notifier {
  private queue: DiscordPayload[] = [];
  private sending = false;

  constructor(
    private readonly getSettings: () => Settings,
    private readonly icon: NativeImage | undefined,
    private readonly onClick: () => void,
  ) {}

  notify(event: NotifyEvent): void {
    const settings = this.getSettings();
    if (!settings.notifyOn[event.kind]) return;
    if (settings.desktopNotifications && Notification.isSupported()) {
      const notification = new Notification({
        title: redact(event.title),
        body: redact(`${event.taskLabel} — ${event.detail}`),
        ...(this.icon ? { icon: this.icon } : {}),
      });
      notification.on('click', this.onClick);
      notification.show();
    }
    if (settings.webhookUrl) this.enqueue(this.buildPayload(event));
  }

  private buildPayload(event: NotifyEvent): DiscordPayload {
    const fields: Array<{ name: string; value: string; inline: boolean }> = [
      { name: 'Retailer', value: RETAILERS[event.retailer].name, inline: true },
    ];
    if (event.price !== undefined) fields.push({ name: 'Price', value: formatUsd(event.price), inline: true });
    if (event.quantity !== undefined) fields.push({ name: 'Quantity', value: String(event.quantity), inline: true });
    if (event.profileName) fields.push({ name: 'Profile', value: `||${redact(event.profileName)}||`, inline: true });
    if (event.orderNumber) fields.push({ name: 'Order', value: `||${redact(event.orderNumber)}||`, inline: true });
    const embed: Record<string, unknown> = {
      title: redact(event.title).slice(0, 250),
      description: redact(`**${event.taskLabel}**\n${event.detail}`).slice(0, 3900),
      color: COLORS[event.kind],
      fields,
      footer: { text: 'Pokemon ACO' },
      timestamp: new Date().toISOString(),
    };
    if (event.productUrl && /^https:\/\//.test(event.productUrl)) embed.url = event.productUrl;
    if (event.imageUrl && /^https:\/\//.test(event.imageUrl)) embed.thumbnail = { url: event.imageUrl };
    return { username: 'Pokemon ACO', allowed_mentions: { parse: [] }, embeds: [embed] };
  }

  private enqueue(payload: DiscordPayload): void {
    // Bound the queue so a webhook outage cannot grow memory without limit.
    if (this.queue.length >= 50) this.queue.shift();
    this.queue.push(payload);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const payload = this.queue.shift();
        const url = this.getSettings().webhookUrl;
        if (!payload || !url) continue;
        const result = await this.post(url, payload);
        if (!result.ok) logBus.warn(`Discord webhook: ${result.message}`);
        // Discord allows a handful of webhook messages per few seconds; stay well under it.
        await sleep(700);
      }
    } finally {
      this.sending = false;
    }
  }

  private async post(url: string, payload: DiscordPayload, attempt = 0): Promise<ActionResult> {
    if (!DISCORD_WEBHOOK_PATTERN.test(url)) return { ok: false, message: 'The webhook URL is not a Discord webhook.' };
    try {
      const response = await net.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 429 && attempt < 2) {
        const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
        const waitSeconds = Math.min(Math.max(body.retry_after ?? 2, 0.5), 30);
        await sleep(waitSeconds * 1000);
        return this.post(url, payload, attempt + 1);
      }
      if (!response.ok) return { ok: false, message: `Discord answered HTTP ${response.status}.` };
      return { ok: true, message: 'Sent.' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Request failed.' };
    }
  }

  async test(): Promise<ActionResult> {
    const url = this.getSettings().webhookUrl;
    if (!url) return { ok: false, message: 'Add a Discord webhook URL first.' };
    return this.post(url, {
      username: 'Pokemon ACO',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: 'Webhook connected',
          description: 'Pokemon ACO will post in-stock, queue, cart, checkout, pause and failure updates here.',
          color: 0x7cc4ff,
          footer: { text: 'Pokemon ACO' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}
