# limo-doi-ve-bot

Bot Zalo (Zalo Bot Platform, không cần OA) hỗ trợ đổi vé LIMO Hoàng Long trong nhóm chat nhân viên.

## Trạng thái

**Bản test hiện tại:** bot nhận tin khi được @nhắc trong nhóm, đọc yêu cầu đổi vé theo mẫu và chuyển cho đúng người duyệt.

| Lệnh (kèm @bot) | Bot làm gì |
| --- | --- |
| `mẫu` | Gửi mẫu yêu cầu đổi vé trống |
| Mẫu đã điền (bắt đầu bằng `ĐỔI VÉ`) | Kiểm tra đủ thông tin, cấp mã `YC001`, báo vé quá hạn, gọi người duyệt |
| `Đồng ý YC001` / `Từ chối YC001 <lý do>` | Người duyệt quyết định |
| `xem YC001` | Xem trạng thái |
| `help`, `ping` | Hướng dẫn, kiểm tra bot |

Mẫu yêu cầu:

```
ĐỔI VÉ
Mã vé: HL123
Tên khách: Nguyễn Văn A
SĐT khách: 0912345678
Điểm đi: Hải Phòng
Chuyến cũ: 08:00 30/10
Ghế cũ: A3
Chuyến mới: 14:00 30/10
Ghế mới: B5
Lý do: Khách bận việc
```

Quy định duyệt: vé đi từ **Hải Phòng** do **Ms Ngọc Anh** duyệt, vé đi từ **Hà Nội** do **Mr Thanh Việt** duyệt. Vé quá hạn (chuyến cũ đã chạy) vẫn nhận nếu được duyệt. Chuyến mới phải sau thời điểm gửi yêu cầu.

Sửa mẫu, nhãn trường hoặc người duyệt ở `src/exchange/template.ts` và `src/exchange/approvers.ts`.

**Chưa có (chờ API Hoàng Long):** kiểm tra ghế trống, chênh lệch giá/phụ thu, đổi vé thật. Yêu cầu đang lưu trong bộ nhớ, khởi động lại bot là mất.

## Cài đặt

Cần Node.js 20 trở lên.

```bash
npm install
cp .env.example .env   # rồi điền ZALO_BOT_TOKEN
npm run check-token    # kiểm tra token (gọi getMe)
npm run dev            # chạy bot, tự tải lại khi sửa code
```

Chạy bản build:

```bash
npm run build
npm start
```

## Hai chế độ nhận tin

| Chế độ | Khi nào dùng | Cấu hình |
| --- | --- | --- |
| `polling` (mặc định) | Chạy trên máy tính hoặc máy chủ không có URL public | `BOT_MODE=polling` |
| `webhook` | Máy chủ có URL https public | `BOT_MODE=webhook`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `PORT` |

Ở chế độ webhook, Zalo gửi kèm header `X-Bot-Api-Secret-Token`; bot từ chối các yêu cầu sai secret. `GET /health` trả `ok` để kiểm tra máy chủ.

## Bảo mật

Token bot nằm trong `.env` (đã có trong `.gitignore`). Không đưa token vào code hay commit. Nếu token bị lộ, tạo token mới trong Zalo Bot Creator.

## Cấu trúc

```
src/
  index.ts        khởi động bot, chọn polling hoặc webhook
  config.ts       đọc biến môi trường
  zalo.ts         client gọi Zalo Bot API
  handler.ts      nhận tin, bỏ @bot, gọi luồng đổi vé
  exchange/       mẫu yêu cầu, người duyệt, luồng duyệt
  polling.ts      nhận tin bằng getUpdates
  webhook.ts      nhận tin qua webhook
  check-token.ts  kiểm tra token
test/             kiểm thử (npm test)
```
