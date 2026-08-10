import { createInterface } from "node:readline/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TG_API_ID ?? 0);
const apiHash = (process.env.TG_API_HASH ?? "").trim();
const stateDir = process.env.TG_STATE_DIR ?? "./data/tg-state";
const sessionPath = join(stateDir, "direct-session.txt");
const configuredPhone = (process.env.TG_PHONE ?? "").trim();

if (!apiId || !apiHash) {
  throw new Error("TG_API_ID und TG_API_HASH sind erforderlich. Beide Werte gibt es unter https://my.telegram.org/apps.");
}

const rl = createInterface({ input, output });
const existingSession = await readFile(sessionPath, "utf8").catch(() => "");
const client = new TelegramClient(new StringSession(existingSession.trim()), apiId, apiHash, { connectionRetries: 5 });

try {
  await client.start({
    phoneNumber: async () => configuredPhone || rl.question("Telegram-Telefonnummer: "),
    phoneCode: async () => rl.question("Telegram-Bestätigungscode: "),
    password: async () => rl.question("Telegram-2FA-Passwort: "),
    onError: (error) => { console.error("Telegram-Anmeldung fehlgeschlagen", error); },
  });
  await mkdir(stateDir, { recursive: true });
  await writeFile(sessionPath, (client.session as StringSession).save(), { encoding: "utf8", mode: 0o600 });
  console.log(`Direct-Telegram-Session gespeichert: ${sessionPath}`);
} finally {
  rl.close();
  await client.disconnect();
}
