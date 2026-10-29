import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApprovers } from "../src/exchange/approvers.ts";
import { RequestStore, respond } from "../src/exchange/flow.ts";
import { parseExchangeRequest } from "../src/exchange/template.ts";
import { formatVn, parseVnDateTime } from "../src/exchange/time.ts";

// 10:00 29/10/2026 giờ Việt Nam
const now = new Date(Date.UTC(2026, 9, 29, 3, 0));

const sample = (origin: string, oldTrip = "08:00 30/10/2026") =>
  [
    "ĐỔI VÉ",
    "Mã vé: hl123",
    "Tên khách: Nguyễn Văn A",
    "SĐT khách: 0912345678",
    `Điểm đi: ${origin}`,
    `Chuyến cũ: ${oldTrip}`,
    "Ghế cũ: A3",
    "Chuyến mới: 14:00 30/10",
    "Ghế mới: B5",
    "Lý do: Khách bận",
  ].join("\n");

const ctx = () => ({
  store: new RequestStore(),
  approvers: loadApprovers({ APPROVER_HAI_PHONG_IDS: "id-ngoc-anh" }),
  now,
});

test("đọc giờ ngày theo giờ Việt Nam", () => {
  assert.equal(formatVn(parseVnDateTime("08:00 30/10/2026", now)!), "08:00 30/10/2026");
  assert.equal(formatVn(parseVnDateTime("30/10 8h30", now)!), "08:30 30/10/2026");
  assert.equal(formatVn(parseVnDateTime("8h 30/10/26", now)!), "08:00 30/10/2026");
  assert.equal(parseVnDateTime("mai", now), undefined);
});

test("đọc mẫu đổi vé đủ thông tin", () => {
  const r = parseExchangeRequest(sample("Hải Phòng"), now);
  assert.ok(r.ok);
  assert.equal(r.request.ticketCode, "HL123");
  assert.equal(r.request.origin, "HAI_PHONG");
  assert.equal(r.request.newSeat, "B5");
});

test("báo thiếu thông tin", () => {
  const r = parseExchangeRequest("ĐỔI VÉ\nMã vé: X\nĐiểm đi: Đà Nẵng", now);
  assert.ok(!r.ok);
  assert.equal(r.errors.length, 3);
});

test("vé Hải Phòng chờ Ms Ngọc Anh, người khác không duyệt được", () => {
  const c = ctx();
  const reply = respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, c);
  assert.match(reply, /YC001/);
  assert.match(reply, /Chờ Ms Ngọc Anh duyệt/);
  assert.match(respond("Đồng ý YC001", { id: "u1", name: "Trang" }, c), /chỉ Ms Ngọc Anh được duyệt/);
  assert.match(respond("đồng ý yc001", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /đã đồng ý đổi YC001/);
  assert.match(respond("xem YC001", { id: "u1", name: "Trang" }, c), /đã duyệt bởi Ngoc Anh/);
});

test("vé Hà Nội chờ Mr Thanh Việt, tạm nhận theo tên khi chưa cấu hình id", () => {
  const c = ctx();
  respond(sample("HN"), { id: "u1", name: "Trang" }, c);
  assert.match(
    respond("Từ chối YC001 hết ghế", { id: "u9", name: "Thanh Việt" }, c),
    /Mr Thanh Việt đã từ chối YC001[\s\S]*Lý do: hết ghế/,
  );
});

test("vé quá hạn vẫn nhận, có cảnh báo", () => {
  const reply = respond(sample("Hải Phòng", "08:00 28/10/2026"), { id: "u1", name: "Trang" }, ctx());
  assert.match(reply, /QUÁ HẠN/);
});
