import { loadConfig } from "./config.js";
import { ZaloBotClient } from "./zalo.js";

const { token } = loadConfig({ ...process.env, BOT_MODE: "polling" });
const bot = await new ZaloBotClient(token).getMe();
console.log("Token hợp lệ:", bot);
