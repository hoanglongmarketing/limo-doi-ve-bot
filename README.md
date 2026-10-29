# limo-doi-ve-bot

Bot Zalo (Zalo Bot Platform, không cần OA) hỗ trợ đổi vé LIMO Hoàng Long trong nhóm chat nhân viên.

## Trạng thái

**Bước 1 (hiện tại):** bot kết nối Zalo, nhận tin nhắn khi được @nhắc trong nhóm (hoặc nhắn riêng) và trả lời lại.

- `ping` → bot trả `pong`
- `help` hoặc @bot không kèm nội dung → hướng dẫn
- Nội dung khác → bot xác nhận đã nhận yêu cầu

**Các bước sau:** đọc yêu cầu đổi vé, kiểm tra giờ đi, ghế trống, chênh lệch giá/phụ thu qua API Hoàng Long, và chỉ đổi khi có xác nhận "Đồng ý" của Ms Ngọc Anh hoặc Mr Thanh Việt.

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
  handler.ts      xử lý tin nhắn và soạn câu trả lời
  polling.ts      nhận tin bằng getUpdates
  webhook.ts      nhận tin qua webhook
  check-token.ts  kiểm tra token
test/             kiểm thử (npm test)
```
