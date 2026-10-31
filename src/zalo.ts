// Client tối giản cho Zalo Bot Platform: https://bot-api.zaloplatforms.com/bot<TOKEN>/<method>

const API_BASE = "https://bot-api.zaloplatforms.com";

export interface ZaloUser {
  id: string;
  display_name?: string;
  is_bot?: boolean;
}

export interface ZaloChat {
  id: string;
  chat_type?: "PRIVATE" | "GROUP" | string;
}

export interface ZaloMessage {
  message_id: string;
  date?: number;
  text?: string;
  from: ZaloUser;
  chat: ZaloChat;
}

export interface ZaloUpdate {
  event_name: string;
  message?: ZaloMessage;
}

export interface BotInfo {
  id: string;
  account_name: string;
  account_type?: string;
  can_join_groups?: boolean;
  display_name: string;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class ZaloApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    description: string | undefined,
  ) {
    super(`Zalo API ${method} lỗi ${code ?? "?"}: ${description ?? "không rõ"}`);
  }
}

export class ZaloBotClient {
  constructor(private readonly token: string) {}

  async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as ApiResponse<T>;
    if (!data.ok) {
      throw new ZaloApiError(method, data.error_code ?? res.status, data.description);
    }
    return data.result as T;
  }

  getMe(): Promise<BotInfo> {
    return this.call("getMe");
  }

  /**
   * Long polling. API trả 408 khi hết thời gian chờ mà không có tin mới;
   * khi đó trả về mảng rỗng. Kết quả có thể là một update hoặc một mảng.
   */
  async getUpdates(timeoutSeconds = 30): Promise<ZaloUpdate[]> {
    try {
      const result = await this.call<ZaloUpdate | ZaloUpdate[] | null>(
        "getUpdates",
        { timeout: timeoutSeconds },
        (timeoutSeconds + 15) * 1000,
      );
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    } catch (err) {
      if (err instanceof ZaloApiError && err.code === 408) return [];
      throw err;
    }
  }

  sendMessage(chatId: string, text: string): Promise<unknown> {
    return this.call("sendMessage", { chat_id: chatId, text });
  }

  sendChatAction(chatId: string, action: "typing" | "upload_photo" = "typing"): Promise<unknown> {
    return this.call("sendChatAction", { chat_id: chatId, action });
  }

  setWebhook(url: string, secretToken: string): Promise<unknown> {
    return this.call("setWebhook", { url, secret_token: secretToken });
  }

  deleteWebhook(): Promise<unknown> {
    return this.call("deleteWebhook");
  }
}
