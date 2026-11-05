import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApprovers } from "../src/exchange/approvers.ts";
import { RequestStore, respond } from "../src/exchange/flow.ts";
import { routeIdOf, seatLabel, seatNumber } from "../src/exchange/codes.ts";
import { apiDate, type ChangeInput, type HoangLongApi, type ShiftInfo, type TicketResult } from "../src/hl/api.ts";

// 14:47 29/10/2026 giờ Việt Nam
const now = new Date(Date.UTC(2026, 9, 29, 7, 47));

interface FakeTicket {
  type: string;
  seat: number;
  date: string;
  start: string;
  allowed: boolean;
  message?: string;
  surcharge: number;
}

/** API giả: giữ ghế trống, ghi lại các lần đổi vé. */
function fakeApi(opts: { shifts?: ShiftInfo[]; tickets?: Record<string, FakeTicket>; free?: number[] } = {}) {
  const free = new Set(opts.free ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const tickets: Record<string, FakeTicket> = opts.tickets ?? {};
  const shifts = opts.shifts ?? [{ ShiftID: 3740, ShiftName: "18:00", FreeSeat: free.size, IsExtra: false }];
  const changes: ChangeInput[] = [];
  const shiftCalls: unknown[][] = [];
  let failNextChange = false;

  const result = (code: string, seat?: number): TicketResult => {
    const t = tickets[code];
    if (!t) return { Status: false, Message: "Không tìm thấy vé", FreeSeats: [...free], StartTime: "18:00", Surcharge: 0, TicketInfo: null };
    const seatOk = seat === undefined || seat === 0 || free.has(seat);
    return {
      Status: t.allowed && seatOk && seat !== 0 && seat !== undefined,
      Message: !t.allowed ? t.message ?? "Không được đổi" : !seatOk ? "Ghế đã bán" : seat ? "Vé được phép đổi chuyến. Chưa phụ thu" : "Chưa chọn ghế",
      FreeSeats: [...free],
      StartTime: "18:00",
      Surcharge: t.allowed ? t.surcharge : 0,
      TicketInfo: { ChangeTicketNote: "", Date: t.date, OrderNumber: code, RouterName: "Hà Đông - Hải Phòng LIMO", Seat: t.seat, StartTime: t.start, TicketType: t.type },
    };
  };

  const api: HoangLongApi = {
    async getShifts(date, routerId, startTime) {
      shiftCalls.push([apiDate(date), routerId, startTime]);
      return shifts.length ? { Status: true, Message: "ok", ShiftInfo: shifts } : { Status: false, Message: "Không tìm thấy chuyến.", ShiftInfo: [] };
    },
    async getUser(user) {
      return user === "ngannn-tn"
        ? { Status: true, Exists: true, FullName: "Nguyễn Ngân", IsBlocked: false, Message: "Tài khoản đang hoạt động." }
        : { Status: false, Exists: false, FullName: null, IsBlocked: false, Message: "Tài khoản không tồn tại." };
    },
    async checkTicket(code, _date, _shift, seat) {
      return result(code, seat);
    },
    async changeTicket(input) {
      if (failNextChange) {
        failNextChange = false;
        // Hệ thống đã đổi nhưng bot không nhận được trả lời.
        applyChange(input);
        throw new Error("timeout");
      }
      const r = result(input.orderNumber, input.seat);
      if (!r.Status) return { ...r, TicketInfo: null };
      applyChange(input);
      return { Status: true, Message: `Vé ${input.orderNumber} đổi chuyến thành công`, FreeSeats: null, StartTime: null, Surcharge: 0, TicketInfo: null };
    },
  };
  function applyChange(input: ChangeInput) {
    changes.push(input);
    free.delete(input.seat);
    const t = tickets[input.orderNumber];
    Object.assign(t, { seat: input.seat, date: apiDate(input.date), start: "18:00", allowed: false, message: "Vé đã đổi chuyến" });
  }
  return { api, changes, shiftCalls, free, failChange: () => (failNextChange = true) };
}

const trang = { id: "u1", name: "Trang" };
const viet = { id: "id-viet", name: "Nguyễn Thanh Việt" };
const ctxWith = (api: HoangLongApi, reports: string[] = []) => ({
  store: new RequestStore(),
  approvers: loadApprovers({ APPROVER_HA_NOI_IDS: "id-viet" }),
  now,
  api,
  reports,
});

const ticket = (type: string, seat: number, surcharge: number, extra: Partial<FakeTicket> = {}): FakeTicket => ({
  type,
  seat,
  surcharge,
  date: "29-10-2026",
  start: "16:45",
  allowed: true,
  ...extra,
});

test("mã tuyến và ghế theo quy ước Hoàng Long", () => {
  assert.equal(routeIdOf("HN-HP"), 11);
  assert.equal(routeIdOf("HP - HN"), 12);
  assert.equal(routeIdOf("HP-HĐ"), 13);
  assert.equal(routeIdOf("HĐ-HP"), 14);
  assert.equal(routeIdOf("HN-HĐ"), undefined);
  assert.equal(seatNumber("5A"), 10);
  assert.equal(seatNumber("6a"), 11);
  assert.equal(seatNumber("12"), undefined);
  assert.equal(seatLabel(11), "6A");
});

test("kiểm tra vé qua API, vé lỗi để lại, người duyệt chọn thu phụ thu rồi bot đổi vé", async () => {
  const fake = fakeApi({
    tickets: {
      A711655: ticket("Vé khứ hồi", 4, 160000),
      A714050: ticket("Vé thường", 7, 0),
      A723183: ticket("Vé thường", 8, 0, { allowed: false, message: "Vé đã đổi chuyến ngoài quy định 1 lần, không thể đổi tiếp" }),
    },
    free: [1, 2, 3, 5, 7, 9],
  });
  const reports: string[] = [];
  const c = ctxWith(fake.api, reports);
  const draft = await respond(
    "A711655 A714050 A723183 , anh đổi giúp em 3 mã vé này chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP ạ (khách bận)",
    trang,
    c,
  );
  assert.deepEqual(fake.shiftCalls[0], ["29-10-2026", 11, "18:00"]);
  assert.match(draft, /Chuyến mới: 18:00 ngày 29-10-2026, còn 6 ghế trống/);
  assert.match(draft, /Lý do: khách bận\n/);
  assert.match(draft, /✅ A711655 \(Vé khứ hồi, ghế cũ 4\) → ghế 3, phụ thu 160\.000đ/);
  assert.match(draft, /✅ A714050 \(Vé thường, ghế cũ 7\) → ghế 1, không phụ thu/);
  assert.match(draft, /❌ A723183 \(Vé thường\): Vé đã đổi chuyến ngoài quy định 1 lần, không thể đổi tiếp → để lại/);
  assert.match(draft, /Tổng phụ thu: 160\.000đ/);
  assert.match(draft, /chưa ghi tài khoản/);

  await respond("xác nhận", trang, c);
  assert.match(await respond("đồng ý", viet, c), /YC001 có phụ thu 160\.000đ[\s\S]*thu[\s\S]*không thu/);
  assert.equal(fake.changes.length, 0);
  assert.match(await respond("đồng ý YC001 thu ai-do", viet, c), /Tài khoản phụ thu ai-do không dùng được/);

  const done = await respond("đồng ý YC001 thu ngannn-tn", viet, c);
  assert.match(done, /✅ A711655: đã đổi sang ghế 3, phụ thu 160\.000đ/);
  assert.match(done, /✅ A714050: đã đổi sang ghế 1/);
  assert.match(done, /❌ A723183: .* → để lại/);
  assert.match(done, /YC001: đã đổi một phần/);
  assert.equal(fake.changes.length, 2);
  assert.deepEqual(
    { ...fake.changes[0], date: apiDate(fake.changes[0].date) },
    {
      orderNumber: "A711655",
      date: "29-10-2026",
      shiftId: 3740,
      seat: 3,
      surcharge: 160000,
      userSurcharge: "ngannn-tn",
      note: "YC001 - duyệt bởi Nguyễn Thanh Việt",
      requestCode: "YC001-A711655",
    },
  );
  assert.equal(fake.changes[1].surcharge, 0);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /ĐỔI MỘT PHẦN ĐỔI VÉ YC001[\s\S]*A711655: đã đổi ghế 3, phụ thu 160\.000đ[\s\S]*Phụ thu: 160\.000đ \(tài khoản ngannn-tn\)/);
  assert.match(await respond("đồng ý YC001", viet, c), /đã được xử lý trước đó/);
});

test("không thu phụ thu thì gửi phụ thu 0", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé khứ hồi", 4, 160000) } });
  const c = ctxWith(fake.api);
  await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(await respond("đồng ý YC001 không thu khách quen", viet, c), /đã đổi vé/);
  assert.equal(fake.changes[0].surcharge, 0);
  assert.equal(fake.changes[0].userSurcharge, "");
  assert.equal(c.store.get("YC001")?.decisionNote, "khách quen");
});

test("không có chuyến thì báo lỗi, không tạo yêu cầu", async () => {
  const fake = fakeApi({ shifts: [], tickets: { A711655: ticket("Vé thường", 7, 0) } });
  const c = ctxWith(fake.api);
  const reply = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(reply, /Không có chuyến 18:00 ngày 29-10-2026 tuyến HN-HP/);
  assert.equal(c.store.lastSeq, 0);
});

test("nhiều chuyến cùng giờ thì người gửi chọn", async () => {
  const fake = fakeApi({
    shifts: [
      { ShiftID: 1, ShiftName: "18:00", FreeSeat: 3, IsExtra: false },
      { ShiftID: 2, ShiftName: "18:00", FreeSeat: 9, IsExtra: true },
    ],
    tickets: { A711655: ticket("Vé thường", 7, 0) },
  });
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(draft, /Có 2 chuyến 18:00[\s\S]*2\. 18:00 ngày 29-10-2026 \(xe tăng cường\), còn 9 ghế trống/);
  assert.match(await respond("xác nhận", trang, c), /cần chọn chuyến trước/);
  const chosen = await respond("chọn 2", trang, c);
  assert.match(chosen, /Chuyến mới: 18:00 ngày 29-10-2026 \(xe tăng cường\)/);
  assert.match(chosen, /✅ A711655/);
  await respond("đồng ý YC001", viet, c);
  assert.equal(fake.changes[0].shiftId, 2);
});

test("ghế vừa bị bán thì bot đề xuất ghế khác, duyệt lại mới đổi", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0) }, free: [7, 8, 9] });
  const c = ctxWith(fake.api);
  await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  fake.free.delete(7); // có người mua ghế 7 trong lúc chờ duyệt
  const first = await respond("đồng ý YC001", viet, c);
  assert.match(first, /ghế 7 vừa có người đặt, bot đề xuất ghế 8[\s\S]*gõ lại: @bot Đồng ý YC001/);
  assert.equal(fake.changes.length, 0);
  assert.match(await respond("đồng ý", viet, c), /đã đổi sang ghế 8/);
  assert.equal(c.store.get("YC001")?.status, "DA_DOI");
});

test("mất kết nối khi đổi: lần sau kiểm tra lại, không đổi hai lần", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0) } });
  const c = ctxWith(fake.api);
  await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  fake.failChange();
  assert.match(await respond("đồng ý YC001", viet, c), /Chưa rõ đã đổi chưa/);
  assert.match(await respond("đồng ý YC001", viet, c), /đã đổi sang ghế 1/);
  assert.equal(fake.changes.length, 1);
  assert.equal(c.store.get("YC001")?.status, "DA_DOI");
});

test("đọc phụ thu và tài khoản phụ thu trong tin", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé khứ hồi", 4, 160000) } });
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP, phụ thu 120k phụ thu bởi ngannn-tn", trang, c);
  assert.match(draft, /Phụ thu: 120\.000đ\nPhụ thu bởi: ngannn-tn/);
  assert.match(draft, /Người gửi ghi phụ thu 120\.000đ, hệ thống tính 160\.000đ/);
  assert.match(draft, /Tài khoản phụ thu ngannn-tn: Nguyễn Ngân/);
  assert.match(await respond("đồng ý YC001 thu", viet, c), /đã đổi vé/);
  assert.equal(fake.changes[0].userSurcharge, "ngannn-tn");
  assert.equal(fake.changes[0].surcharge, 160000);
});
