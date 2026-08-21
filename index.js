require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Collection } = require("discord.js");
const config = require("./config");
const { loadCommandFiles } = require("./utils/loadCommands");
const logger = require("./utils/logger");
require("./database/db"); // veritabanini baslat (tablolari olustur)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

// --- Komutlari yukle (commands/ altindaki tum kategori klasorlerini tara) ---
client.commands = new Collection();
client.cooldowns = new Collection();
const commandsPath = path.join(__dirname, "commands");
for (const file of loadCommandFiles(commandsPath)) {
  const command = require(file);
  if (command?.data?.name) client.commands.set(command.data.name, command);
  else console.warn(`⚠️  Gecersiz komut dosyasi (data/name eksik): ${file}`);
}
console.log(`📦 ${client.commands.size} slash komutu yuklendi.`);

// --- Eventleri yukle ---
const eventsPath = path.join(__dirname, "events");
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith(".js"))) {
  const event = require(path.join(eventsPath, file));
  if (event.once) client.once(event.name, (...args) => event.execute(...args, client));
  else client.on(event.name, (...args) => event.execute(...args, client));
}

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  logger.error(`Unhandled rejection: ${err.message}`);
});

if (!config.token) {
  console.error("DISCORD_TOKEN .env dosyasinda tanimli degil!");
  process.exit(1);
}

client.login(config.token);
