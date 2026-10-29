# Lưu dữ liệu đổi vé vào Google Sheet

Bot ghi mỗi yêu cầu đổi vé thành một dòng trong Google Sheet (tìm theo "Mã YC": có rồi thì cập nhật, chưa có thì thêm dòng). Bot vẫn lưu song song vào `data/requests.json`.

## Cài đặt (làm một lần)

1. Trong thư mục Google Drive muốn lưu, tạo một Google Sheet mới, vd "Dữ liệu đổi vé LIMO".
2. Mở sheet, chọn **Tiện ích mở rộng → Apps Script**.
3. Xoá hết code có sẵn, dán toàn bộ nội dung file [`scripts/google-sheet.gs`](../scripts/google-sheet.gs). Đổi dòng `var SECRET = "..."` thành một mật khẩu riêng. Bấm **Lưu**.
4. Bấm **Triển khai → Tùy chọn triển khai mới**. Ở "Chọn loại", chọn **Ứng dụng web**:
   - Thực thi với tư cách: **Tôi**
   - Người có quyền truy cập: **Bất kỳ ai**
5. Bấm **Triển khai**, cho phép quyền truy cập khi Google hỏi (chọn tài khoản, "Nâng cao" → "Đi tới ... (không an toàn)" → "Cho phép"; đây là script của chính mình).
6. Sao chép **URL ứng dụng web** (kết thúc bằng `/exec`) và điền vào `.env` của bot:

```
SHEET_WEBHOOK_URL=https://script.google.com/macros/s/.../exec
SHEET_WEBHOOK_SECRET=<mật khẩu ở bước 3>
```

Khởi động lại bot. Tab "Đổi vé" sẽ tự được tạo cùng dòng tiêu đề ở lần ghi đầu tiên.

## Ghi chú

- Ai có URL và mật khẩu mới ghi được vào sheet; URL không cho đọc dữ liệu.
- Sửa script sau này: **Triển khai → Quản lý triển khai → sửa → Phiên bản mới**, URL giữ nguyên.
- Đổi tên hoặc thứ tự cột: sửa `SHEET_COLUMNS` trong `src/exchange/sheet.ts`, không cần sửa script (nên xoá dòng tiêu đề cũ trên sheet).
