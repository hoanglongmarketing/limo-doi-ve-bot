/**
 * Apps Script nhận dữ liệu đổi vé từ bot và ghi vào Google Sheet.
 * Cách cài: xem docs/google-sheet.md.
 *
 * Bot gửi: { secret, columns: [tên cột...], row: [giá trị...] }
 * Cột đầu tiên ("Mã YC") dùng để tìm dòng: có rồi thì ghi đè, chưa có thì thêm dòng mới.
 */

// Đổi chuỗi này thành mật khẩu riêng, và điền đúng chuỗi đó vào SHEET_WEBHOOK_SECRET của bot.
var SECRET = "doi-mat-khau-nay";
var SHEET_NAME = "Đổi vé";

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return json({ ok: false, error: "Sai mật khẩu" });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(data.columns);
      sheet.getRange(1, 1, 1, data.columns.length).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }

    // Ghi dạng chữ để Google Sheet không tự đổi "08:00 30/10/2026" hay số điện thoại.
    var row = data.row.map(function (v) { return v === "" ? "" : "'" + v; });
    var ids = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues() : [];
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === data.row[0]) {
        sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return json({ ok: true, action: "updated" });
      }
    }
    sheet.appendRow(row);
    return json({ ok: true, action: "added" });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
