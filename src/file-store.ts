import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseStored, RequestStore } from "./exchange/store.js";

/** Store ghi ra file JSON (khi chạy bằng Node): khởi động lại bot không mất dữ liệu. */
export function openFileStore(filePath: string): RequestStore {
  let snapshot;
  try {
    snapshot = parseStored(readFileSync(filePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return new RequestStore(snapshot, (store) => {
    const json = JSON.stringify(store.snapshot(), null, 2);
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, filePath);
  });
}
