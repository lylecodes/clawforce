import { resolveApprovalChannel } from "../src/approval/channel-router.js";
import {
  type ApprovalNotifier,
  type NotificationPayload,
  buildApprovalButtons,
  formatTelegramMessage,
  setApprovalNotifier,
} from "../src/approval/notify.js";
import { registerKillFunction } from "../src/audit/auto-kill.js";
import { setDeliveryAdapter } from "../src/channels/deliver.js";
import { formatChannelMessage, setChannelNotifier } from "../src/channels/notify.js";
import { getDb } from "../src/db.js";
import { setCronService, getCronService } from "../src/manager-cron.js";
import type { CronJobRecord, CronServiceLike } from "../src/manager-cron.js";
import { formatMessageNotification, setMessageNotifier } from "../src/messaging/notify.js";

type LoggerLike = {
  info(message: string): void;
  warn(message: string): void;
};

type AbortControllerEntry = {
  sessionKey: string;
  controller: { abort(): void };
};

type ChatAbortControllers = Map<string, AbortControllerEntry>;

type TelegramSendResult = {
  messageId?: string;
};

type TelegramSendFn = (
  chatId: string,
  content: string,
  options?: Record<string, unknown>,
) => Promise<TelegramSendResult>;

type CronGatewayPort = {
  add(input: Record<string, unknown>): Promise<unknown>;
  list?(opts?: { includeDisabled?: boolean }): Promise<CronJobRecord[]>;
  update?(id: string, patch: Record<string, unknown>): Promise<unknown>;
  remove?(id: string): Promise<unknown>;
  run?(id: string): Promise<unknown>;
};

function createCronService(cron: CronGatewayPort): CronServiceLike {
  return {
    add: async (input: Record<string, unknown>) => cron.add(input),
    list: async (opts?: { includeDisabled?: boolean }) => cron.list ? cron.list(opts) : [],
    update: async (id: string, patch: Record<string, unknown>) => cron.update ? cron.update(id, patch) : undefined,
    remove: async (id: string) => cron.remove ? cron.remove(id) : undefined,
    run: async (id: string) => cron.run ? cron.run(id) : undefined,
  };
}

export function wireGatewayKillBridge(args: {
  chatAbortControllers?: ChatAbortControllers;
  logger: LoggerLike;
}): void {
  const { chatAbortControllers, logger } = args;
  if (!chatAbortControllers) return;

  registerKillFunction(async (sessionKey, reason) => {
    for (const [runId, entry] of chatAbortControllers) {
      if (entry.sessionKey === sessionKey) {
        entry.controller.abort();
        chatAbortControllers.delete(runId);
        logger.info(`Clawforce: killed session ${sessionKey} — ${reason}`);
        return true;
      }
    }
    return false;
  });
}

export function wireGatewayTelegramPorts(args: {
  logger: LoggerLike;
  sendTelegram?: TelegramSendFn;
}): boolean {
  const { logger, sendTelegram } = args;
  if (!sendTelegram) return false;

  setDeliveryAdapter({
    send: async (channel, content, target, options) => {
      switch (channel) {
        case "telegram": {
          try {
            const sendOpts: Record<string, unknown> = {
              textMode: options?.format ?? "markdown",
            };
            if (options?.buttons) sendOpts.buttons = options.buttons;
            if (target.threadId) sendOpts.messageThreadId = Number(target.threadId);
            const result = await sendTelegram(
              String(target.chatId ?? ""),
              content,
              sendOpts,
            );
            return { sent: !!result, messageId: result?.messageId };
          } catch (err) {
            return { sent: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        default:
          return { sent: false, error: `Unsupported channel: ${channel}` };
      }
    },
  });
  logger.info("Clawforce: unified delivery adapter configured (Telegram)");

  const notifier: ApprovalNotifier = {
    async sendProposalNotification(payload: NotificationPayload) {
      const channel = resolveApprovalChannel(payload.projectId, payload.proposedBy);
      if (channel.channel !== "telegram") {
        return { sent: false, channel: channel.channel };
      }

      const target = channel.target;
      if (!target) {
        return { sent: false, channel: "telegram", error: "No Telegram target configured" };
      }

      try {
        const message = formatTelegramMessage(payload);
        const buttons = buildApprovalButtons(payload.projectId, payload.proposalId);
        const result = await sendTelegram(target, message, {
          textMode: "markdown",
          buttons,
          messageThreadId: channel.threadId,
        });

        try {
          const db = getDb(payload.projectId);
          db.prepare(
            "UPDATE proposals SET notification_message_id = ?, channel = 'telegram' WHERE id = ? AND project_id = ?",
          ).run(result.messageId ?? null, payload.proposalId, payload.projectId);
        } catch {
          // Non-fatal audit update.
        }

        return { sent: true, channel: "telegram", messageId: result.messageId };
      } catch (err) {
        logger.warn(`Clawforce: failed to send Telegram notification: ${err instanceof Error ? err.message : String(err)}`);
        return { sent: false, channel: "telegram", error: err instanceof Error ? err.message : String(err) };
      }
    },

    async editProposalMessage() {
      // Message editing requires editMessageTelegram which isn't on the runtime channel API.
    },
  };

  setApprovalNotifier(notifier);
  logger.info("Clawforce: approval notifier configured (Telegram)");

  setMessageNotifier({
    async sendMessageNotification(message) {
      try {
        const msgChannel = resolveApprovalChannel(message.projectId, message.toAgent);
        if (msgChannel.channel !== "telegram" || !msgChannel.target) {
          return { sent: false, error: "No Telegram target" };
        }
        const text = formatMessageNotification(message);
        const result = await sendTelegram(msgChannel.target, text, { textMode: "markdown" });
        return { sent: true, messageId: result?.messageId };
      } catch (err) {
        return { sent: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  logger.info("Clawforce: message notifier configured (Telegram)");

  setChannelNotifier({
    async sendChannelNotification({ channel, message }) {
      const telegramGroupId = (channel.metadata as Record<string, unknown> | undefined)?.telegramGroupId as string | undefined;
      if (!telegramGroupId) return { sent: false, error: "No Telegram group configured" };

      try {
        const text = formatChannelMessage(channel, message);
        const telegramThreadId = (channel.metadata as Record<string, unknown> | undefined)?.telegramThreadId as number | undefined;
        await sendTelegram(telegramGroupId, text, {
          textMode: "markdown",
          ...(telegramThreadId ? { messageThreadId: telegramThreadId } : {}),
        });
        return { sent: true };
      } catch (err) {
        return { sent: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  logger.info("Clawforce: channel notifier configured (Telegram)");

  return true;
}

export function wireGatewayCronService(args: {
  cron?: CronGatewayPort;
  logger: LoggerLike;
  onlyIfMissing?: boolean;
  logMessage?: string | false;
}): boolean {
  const { cron, logger, onlyIfMissing = false, logMessage } = args;
  if (!cron) return false;
  if (onlyIfMissing && getCronService()) return false;

  setCronService(createCronService(cron));
  if (logMessage) {
    logger.info(logMessage);
  }
  return true;
}
