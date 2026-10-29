import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApprovers } from "../src/exchange/approvers.ts";
import { RequestStore, respond } from "../src/exchange/flow.ts";
import { SHEET_COLUMNS, SheetSync } from "../src/exchange/sheet.ts";

test("mỗi thay đổi gửi một dòng sang Google Sheet, đúng thứ tự", async () => {
  const sent: { secret: string; columns: string[]; row: string[] }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  try {
    const store = new RequestStore();
    const sync = new SheetSync("https://example.com/exec", "mk");
    store.onChange((item) => sync.push(item));
    const ctx = { store, approvers: loadApprovers({}), now: new Date(Date.UTC(2026, 9, 29, 7, 47)), chatId: "zgr-1" };

    respond("A711655 A714050 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP (xe hỏng)", { id: "u1", name: "Trang" }, ctx);
    respond("xác nhận", { id: "u1", name: "Trang" }, ctx);
    respond("Đồng ý YC001", { id: "u9", name: "Nguyễn Thanh Việt" }, ctx);
    await sync.flush();

    assert.equal(sent.length, 3);
    assert.equal(sent[0].secret, "mk");
    assert.deepEqual(sent[0].columns, [...SHEET_COLUMNS]);
    const col = (row: string[], name: (typeof SHEET_COLUMNS)[number]) => row[SHEET_COLUMNS.indexOf(name)];
    assert.equal(col(sent[0].row, "Trạng thái"), "Chờ người gửi xác nhận");
    assert.equal(col(sent[1].row, "Trạng thái"), "Chờ duyệt");
    const last = sent[2].row;
    assert.equal(col(last, "Mã YC"), "YC001");
    assert.equal(col(last, "Trạng thái"), "Đã duyệt");
    assert.equal(col(last, "Mã vé"), "A711655, A714050");
    assert.equal(col(last, "Tuyến cũ"), "HĐ-HP");
    assert.equal(col(last, "Người duyệt"), "Nguyễn Thanh Việt");
    assert.equal(col(last, "Nhóm Zalo"), "zgr-1");
  } finally {
    globalThis.fetch = realFetch;
  }
});
