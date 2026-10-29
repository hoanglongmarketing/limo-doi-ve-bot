import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMention } from "../src/handler.ts";

test("bỏ @tên bot ở đầu hoặc cuối tin", () => {
  assert.equal(stripMention("@Bot HL Support đổi vé ABC123", ["Bot HL Support"]), "đổi vé ABC123");
  assert.equal(stripMention("@bot hl support: ping", ["Bot HL Support"]), "ping");
  assert.equal(stripMention("ping @Bot HL Support", ["Bot HL Support"]), "ping");
  assert.equal(stripMention("@Bot HL Support\nĐỔI VÉ\nMã vé: A1", ["Bot HL Support"]), "ĐỔI VÉ\nMã vé: A1");
});
