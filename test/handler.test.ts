import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMention } from "../src/bot.ts";

test("bỏ @tên bot ở đầu hoặc cuối tin", () => {
  assert.equal(stripMention("@Bot HL Support đổi vé ABC123", ["Bot HL Support"]), "đổi vé ABC123");
  assert.equal(stripMention("@bot hl support: ping", ["Bot HL Support"]), "ping");
  assert.equal(stripMention("ping @Bot HL Support", ["Bot HL Support"]), "ping");
  assert.equal(stripMention("@Bot HL Support\nĐỔI VÉ\nMã vé: A1", ["Bot HL Support"]), "ĐỔI VÉ\nMã vé: A1");
  // Nhiều dấu cách, dấu cách đặc biệt (non-breaking, zero-width) Zalo chèn vào
  assert.equal(stripMention("@Bot HL Support      ping", ["Bot HL Support"]), "ping");
  assert.equal(stripMention("@Bot\u00a0HL  Support\u00a0\u00a0\u00a0đổi   vé", ["Bot HL Support"]), "đổi vé");
  assert.equal(stripMention("@Bot HL Support \u200b\u200b ping", ["Bot HL Support"]), "ping");
});

import { createBot } from "../src/bot.ts";
import { RequestStore } from "../src/exchange/store.ts";
import type { ZaloBotClient, ZaloUpdate } from "../src/zalo.ts";

test("nhắn riêng với bot: xác nhận xong chuyển vào nhóm duyệt, có kết quả thì nhắn riêng người gửi", async () => {
  const sent: { chatId: string; text: string }[] = [];
  const client = {
    sendMessage: async (chatId: string, text: string) => sent.push({ chatId, text }),
    sendChatAction: async () => undefined,
  } as unknown as ZaloBotClient;
  const bot = createBot(client, { id: "bot", account_name: "hlbot", display_name: "Bot HL Support" }, new RequestStore(), {
    REQUEST_GROUP_IDS: "group-1",
    REPORT_GROUP_ID: "report-1",
    APPROVER_HA_NOI_IDS: "id-viet",
  });
  const msg = (chatId: string, from: { id: string; display_name: string }, text: string, chat_type: string): ZaloUpdate => ({
    event_name: "message.text.received",
    message: { message_id: String(Math.random()), text, from, chat: { id: chatId, chat_type } },
  });
  const trang = { id: "u-trang", display_name: "Trang" };
  const viet = { id: "id-viet", display_name: "Việt" };
  const tomorrow = new Date(Date.now() + 86_400_000);
  const day = `${tomorrow.getUTCDate()}/${tomorrow.getUTCMonth() + 1}/${tomorrow.getUTCFullYear()}`;

  await bot.handleUpdate(msg("u-trang", trang, `A711655 đổi chuyến 16h45 HĐ-HP ngày ${day} sang chuyến 18h HN-HP (khách bận)`, "PRIVATE"));
  // Tin soạn gọn, rồi tin form riêng để sao chép sửa
  assert.equal(sent.length, 2);
  assert.ok(sent.every((m) => m.chatId === "u-trang"));
  assert.match(sent[0].text, /📝 Em đã soạn yêu cầu ĐỔI VÉ YC001[\s\S]*Sai thì sao chép tin form bên dưới, sửa rồi gửi lại\./);
  assert.doesNotMatch(sent[0].text, /kèm @bot/);
  assert.match(sent[1].text, /^ĐỔI VÉ\nMã vé: A711655\n/);

  sent.length = 0;
  await bot.handleUpdate(msg("u-trang", trang, "xác nhận", "PRIVATE"));
  assert.match(sent.find((m) => m.chatId === "u-trang")!.text, /Đã chuyển YC001 .* vào nhóm đổi vé/);
  const posted = sent.find((m) => m.chatId === "group-1")!.text;
  // Tin nhóm: gọn, viết tắt (mẫu 23/11)
  assert.match(posted, /^Đã nhận y\/c ĐỔI VÉ YC001\ntừ Trang \(ib-xn lúc \d\d:\d\d \d\d-\d\d-\d{4}\):\n_+\n🎫 Mã vé: A711655\n🚩 Điểm đi: Hà Nội\n🚐Từ: 16:45 [\d-]+ HĐ-HP\n🚐 Sang: 18:00 [\d-]+ HN-HP\n📝 Lý do: khách bận\n_+\n👉 Chờ .+ duyệt$/);
  // Bản đầy đủ vẫn gửi riêng người duyệt
  assert.match(sent.find((m) => m.chatId === "id-viet")!.text, /✍️ Nhân viên xác nhận: Trang lúc/);
  assert.ok(sent.some((m) => m.chatId === "id-viet"));

  sent.length = 0;
  await bot.handleUpdate(msg("group-1", viet, "@Bot HL Support từ chối YC001 hết ghế", "GROUP"));
  assert.match(sent.find((m) => m.chatId === "group-1")!.text, /đã từ chối YC001/);
  assert.match(sent.find((m) => m.chatId === "u-trang")!.text, /Kết quả yêu cầu đổi vé[\s\S]*TỪ CHỐI ĐỔI VÉ YC001[\s\S]*hết ghế/);
  assert.ok(sent.some((m) => m.chatId === "report-1"));

  // Gửi yêu cầu đổi vé trong nhóm: bot không nhận, nhắc nhắn riêng
  sent.length = 0;
  await bot.handleUpdate(msg("group-1", trang, `@Bot HL Support A711657 đổi sang chuyến 18h HN-HP ngày ${day}`, "GROUP"));
  await bot.handleUpdate(msg("group-1", trang, "@Bot HL Support mẫu", "GROUP"));
  await bot.handleUpdate(msg("group-1", trang, "@Bot HL Support lấy hóa đơn A711657", "GROUP"));
  assert.deepEqual(sent.map((m) => [m.chatId, m.text]), [
    ["group-1", "Vui lòng gửi tin nhắn yêu cầu RIÊNG cho bot!"],
    ["group-1", "Vui lòng gửi tin nhắn yêu cầu RIÊNG cho bot!"],
    ["group-1", "Vui lòng gửi tin nhắn yêu cầu RIÊNG cho bot!"],
  ]);

  // Yêu cầu thứ hai: người duyệt từ chối ngay trong tin nhắn riêng, kết quả vẫn báo vào nhóm.
  sent.length = 0;
  await bot.handleUpdate(msg("u-trang", trang, `A711656 đổi chuyến 16h45 HĐ-HP ngày ${day} sang chuyến 18h HN-HP`, "PRIVATE"));
  await bot.handleUpdate(msg("u-trang", trang, "xác nhận", "PRIVATE"));
  sent.length = 0;
  await bot.handleUpdate(msg("id-viet", viet, "từ chối YC002 khách hủy", "PRIVATE"));
  assert.match(sent.find((m) => m.chatId === "id-viet")!.text, /đã từ chối YC002/);
  assert.match(sent.find((m) => m.chatId === "group-1")!.text, /đã từ chối YC002/);
  assert.match(sent.find((m) => m.chatId === "u-trang")!.text, /TỪ CHỐI ĐỔI VÉ YC002/);
});
