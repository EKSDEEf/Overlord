import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import * as clientManager from "../../clientManager";
import { getConfig, updateNotificationsConfig } from "../../config";
import { encodeMessage } from "../../protocol";
import {
  getUserNotificationSettings,
  updateUserNotificationSettings,
} from "../../users";
import {
  DEFAULT_WEBHOOK_TEMPLATE,
  DEFAULT_TELEGRAM_TEMPLATE,
  renderNotificationTemplate,
} from "../notification-delivery";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

type NotificationsRouteDeps = {
  getNotificationScreenshot: (notificationId: string) => { format?: string; bytes: Uint8Array } | null;
  secureHeaders: (contentType?: string) => HeadersInit;
};

export async function handleNotificationsConfigRoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
  deps: NotificationsRouteDeps,
): Promise<Response | null> {
  const screenshotMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/screenshot$/);
  if (req.method === "GET" && screenshotMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const notificationId = decodeURIComponent(screenshotMatch[1]);
    const screenshot = deps.getNotificationScreenshot(notificationId);
    if (!screenshot) {
      return new Response("Not found", { status: 404 });
    }

    const format = (screenshot.format || "jpeg").toLowerCase();
    const contentType = format === "jpg" || format === "jpeg"
      ? "image/jpeg"
      : format === "png"
        ? "image/png"
        : format === "webp"
          ? "image/webp"
          : "application/octet-stream";

    return new Response(screenshot.bytes as unknown as BodyInit, {
      headers: deps.secureHeaders(contentType),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/notifications/config") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (user.role === "viewer") {
      return new Response("Forbidden: Viewer access denied", { status: 403 });
    }
    return Response.json({ notifications: getConfig().notifications });
  }

  if (req.method === "PUT" && url.pathname === "/api/notifications/config") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (user.role !== "admin" && user.role !== "operator") {
      return new Response("Forbidden: Admin or operator access required", {
        status: 403,
      });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const currentConfig = getConfig().notifications;
    const hasKeywords = Array.isArray(body?.keywords);
    const rawKeywords = hasKeywords ? body.keywords : currentConfig.keywords || [];
    const keywords = rawKeywords
      .map((k: any) => String(k).trim())
      .filter(Boolean)
      .slice(0, 200);

    const webhookEnabled =
      typeof body?.webhookEnabled === "boolean"
        ? body.webhookEnabled
        : currentConfig.webhookEnabled;
    const webhookUrl =
      typeof body?.webhookUrl === "string"
        ? body.webhookUrl.trim()
        : currentConfig.webhookUrl || "";
    const telegramEnabled =
      typeof body?.telegramEnabled === "boolean"
        ? body.telegramEnabled
        : currentConfig.telegramEnabled;
    const telegramBotToken =
      typeof body?.telegramBotToken === "string"
        ? body.telegramBotToken.trim()
        : currentConfig.telegramBotToken || "";
    const telegramChatId =
      typeof body?.telegramChatId === "string"
        ? body.telegramChatId.trim()
        : currentConfig.telegramChatId || "";

    if (webhookUrl) {
      try {
        const parsed = new URL(webhookUrl);
        if (!/^https?:$/.test(parsed.protocol)) {
          return Response.json(
            { error: "Webhook URL must be http(s)" },
            { status: 400 },
          );
        }
      } catch {
        return Response.json({ error: "Invalid webhook URL" }, { status: 400 });
      }
    }

    const updated = await updateNotificationsConfig({
      keywords,
      webhookEnabled,
      webhookUrl,
      telegramEnabled,
      telegramBotToken,
      telegramChatId,
    });

    for (const client of clientManager.getAllClients().values()) {
      if (client.role !== "client") continue;
      try {
        client.ws.send(
          encodeMessage({
            type: "notification_config",
            keywords: updated.keywords || [],
            minIntervalMs: updated.minIntervalMs || 8000,
          }),
        );
      } catch {}
    }

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: server.requestIP(req)?.address || "unknown",
      action: AuditAction.COMMAND,
      details: `Updated notification keywords (${updated.keywords.length})`,
      success: true,
    });

    return Response.json({ ok: true, notifications: updated });
  }

  if (url.pathname === "/api/notifications/my-settings") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "GET") {
      const settings = getUserNotificationSettings(user.userId) ?? {
        webhook_enabled: 0,
        webhook_url: null,
        webhook_template: null,
        telegram_enabled: 0,
        telegram_bot_token: null,
        telegram_chat_id: null,
        telegram_template: null,
      };
      return Response.json({
        settings,
        defaults: {
          webhookTemplate: DEFAULT_WEBHOOK_TEMPLATE,
          telegramTemplate: DEFAULT_TELEGRAM_TEMPLATE,
        },
      });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const patch: Record<string, any> = {};

      if (typeof body?.webhook_enabled === "boolean" || typeof body?.webhook_enabled === "number") {
        patch.webhook_enabled = body.webhook_enabled ? 1 : 0;
      }
      if (typeof body?.webhook_url === "string") {
        const url_val = body.webhook_url.trim();
        if (url_val) {
          try {
            const parsed = new URL(url_val);
            if (!/^https?:$/.test(parsed.protocol)) {
              return Response.json({ error: "Webhook URL must use http(s)" }, { status: 400 });
            }
          } catch {
            return Response.json({ error: "Invalid webhook URL" }, { status: 400 });
          }
        }
        patch.webhook_url = url_val || null;
      }
      if (typeof body?.webhook_template === "string") {
        patch.webhook_template = body.webhook_template.trim() || null;
      }
      if (typeof body?.telegram_enabled === "boolean" || typeof body?.telegram_enabled === "number") {
        patch.telegram_enabled = body.telegram_enabled ? 1 : 0;
      }
      if (typeof body?.telegram_bot_token === "string") {
        patch.telegram_bot_token = body.telegram_bot_token.trim() || null;
      }
      if (typeof body?.telegram_chat_id === "string") {
        patch.telegram_chat_id = body.telegram_chat_id.trim() || null;
      }
      if (typeof body?.telegram_template === "string") {
        patch.telegram_template = body.telegram_template.trim() || null;
      }

      const result = updateUserNotificationSettings(user.userId, patch);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const updated = getUserNotificationSettings(user.userId);
      return Response.json({ ok: true, settings: updated });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/notifications/my-settings/preview/webhook") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const webhookUrl = typeof body?.webhookUrl === "string" ? body.webhookUrl.trim() : "";
    const webhookTemplate = typeof body?.webhookTemplate === "string" ? body.webhookTemplate : "";

    if (!webhookUrl) {
      return Response.json({ error: "Webhook URL is required" }, { status: 400 });
    }

    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
      if (!/^https?:$/.test(parsed.protocol)) {
        return Response.json({ error: "Webhook URL must use http(s)" }, { status: 400 });
      }
    } catch {
      return Response.json({ error: "Invalid webhook URL" }, { status: 400 });
    }

    const sampleRecord = {
      id: "preview-notification",
      clientId: "abc123def456",
      host: "DESKTOP-7G2ABK1",
      user: "john.doe",
      os: "windows",
      title: "Online Banking - Secure Login",
      process: "chrome.exe",
      processPath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      pid: 4392,
      keyword: "bank",
      category: "active_window" as const,
      ts: Date.now(),
    };

    const payload = renderNotificationTemplate(
      webhookTemplate,
      sampleRecord,
      DEFAULT_WEBHOOK_TEMPLATE,
    );

    const canonicalPayload = JSON.stringify({ type: "notification", data: sampleRecord });
    const customTemplate = webhookTemplate.trim();
    let jsonPayloadToSend = canonicalPayload;
    if (customTemplate) {
      try {
        jsonPayloadToSend = JSON.stringify(JSON.parse(payload));
      } catch {
        jsonPayloadToSend = canonicalPayload;
      }
    }

    try {
      const isDiscord = /discord(app)?\.com$/i.test(parsed.hostname);
      let response: Response;
      let sentPayload = jsonPayloadToSend;
      let sentMode: "json" | "discord" = "json";

      if (isDiscord) {
        sentMode = "discord";
        const discordPayload = {
          content: `🔔 Notification: ${sampleRecord.title}`,
          embeds: [
            {
              title: sampleRecord.keyword ? `Keyword: ${sampleRecord.keyword}` : "Active Window",
              description: sampleRecord.title,
              fields: [
                { name: "Client", value: sampleRecord.clientId || "unknown", inline: true },
                { name: "User", value: sampleRecord.user || "unknown", inline: true },
                { name: "Host", value: sampleRecord.host || "unknown", inline: true },
                { name: "Process", value: sampleRecord.process || "unknown", inline: true },
              ],
              timestamp: new Date(sampleRecord.ts).toISOString(),
            },
          ],
        };
        sentPayload = JSON.stringify(discordPayload);
        response = await fetch(parsed.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: sentPayload,
        });
      } else {
        response = await fetch(parsed.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: jsonPayloadToSend,
        });
      }

      const responseText = await response.text().catch(() => "");

      return Response.json({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        mode: sentMode,
        payload: sentPayload,
        responseBody: responseText ? responseText.slice(0, 500) : "",
      });
    } catch (err: any) {
      return Response.json(
        { error: err?.message || "Failed to POST preview webhook" },
        { status: 502 },
      );
    }
  }

  return null;
}
