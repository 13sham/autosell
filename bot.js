/**
 * AutoSell - Discord bot for selling in-game money for Litecoin.
 * Inspired by the xauto-style panel, but with its own look and flow.
 *
 * Features
 * --------
 * - /panel     : posts the public AutoSell embed with 3 buttons (Sell, Settings, Balance)
 * - /setprice  : admin - set USD price per 1 billion in-game money
 * - /maxsell   : admin - set the max amount (in billions) allowed per sell
 * - /bal       : admin - set the shop's USD balance (liquidity). Balance 0 auto-closes sells
 * - /balance   : anyone - shows Current Rate / USD Balance / Max Sell
 * - Settings button : each user saves their own IGN + LTC address once
 * - Sell button      : user enters an amount, bot shows the payout + the /pay command to run
 *
 * Setup
 * -----
 * npm install discord.js dotenv
 * fill in .env (DISCORD_TOKEN, CLIENT_ID, and optionally GUILD_ID for instant command updates)
 * node bot.js
 *
 * Data is persisted to autosell_data.json next to this script.
 */
const http = require("http");
http
  .createServer((req, res) => res.end("AutoSell is running"))
  .listen(process.env.PORT || 3000, () => console.log("Health server up"));
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

// ---------- Config ----------

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional, for instant per-guild command updates
const BOT_NAME = "AutoSell";
const DATA_FILE = path.join(__dirname, "autosell_data.json");

const DEFAULT_DATA = {
  shop: {
    price_per_billion: 0, // USD per 1b in-game money
    max_sell: 0, // max sell per transaction, in billions
    balance: 0, // shop's available USD balance (liquidity)
    open: true,
  },
  users: {}, // discordUserId -> { ign, ltc_address }
};

// ---------- Storage ----------

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { ...DEFAULT_DATA, ...raw, shop: { ...DEFAULT_DATA.shop, ...raw.shop }, users: raw.users || {} };
  }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

let data = loadData();

const fmtUsd = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtBillions = (n) => `${Number(n).toFixed(2)}b`;

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

// ---------- Slash command definitions ----------

const commands = [
  new SlashCommandBuilder().setName("panel").setDescription("Post the AutoSell panel"),
  new SlashCommandBuilder()
    .setName("setprice")
    .setDescription("Admin: set the USD price per billion")
    .addNumberOption((opt) =>
      opt.setName("usd_per_billion").setDescription("Price in USD for 1 billion in-game money").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("maxsell")
    .setDescription("Admin: set the max sell amount (in billions)")
    .addNumberOption((opt) =>
      opt.setName("billions").setDescription("Max amount a single sell can be, in billions").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("bal")
    .setDescription("Admin: set the shop's USD balance")
    .addNumberOption((opt) => opt.setName("usd").setDescription("New USD balance for the shop").setRequired(true)),
  new SlashCommandBuilder().setName("balance").setDescription("View the current rate, balance, and max sell"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} command(s)${GUILD_ID ? " to guild " + GUILD_ID : " globally"}.`);
}

// ---------- Panel embed + buttons ----------

function panelEmbed() {
  const shop = data.shop;
  return new EmbedBuilder()
    .setTitle(BOT_NAME)
    .setDescription("Sell your in-game money for instant Litecoin — no waiting, no haggling.")
    .setColor(0x5b2a86)
    .addFields(
      {
        name: "How it works",
        value:
          "1. 🔑 **Settings** — save your IGN + LTC address *(one-time)*\n" +
          "2. 💸 **Sell** — tap the button, enter an amount\n" +
          "3. 🎮 **Pay in-game** — run the `/pay` command shown\n" +
          "4. 🚀 **Get paid** — LTC lands in your wallet automatically",
      },
      { name: "Current Rate", value: `${fmtUsd(shop.price_per_billion)}/1b`, inline: true },
      { name: "Max Sell", value: fmtBillions(shop.max_sell), inline: true }
    );
}

function balanceEmbed() {
  const shop = data.shop;
  return new EmbedBuilder()
    .setTitle(`${BOT_NAME} — Shop Balance`)
    .setColor(0x5865f2)
    .addFields(
      { name: "Current Rate", value: `${fmtUsd(shop.price_per_billion)}/1b` },
      { name: "USD Balance", value: fmtUsd(shop.balance) },
      { name: "Max Sell", value: fmtBillions(shop.max_sell) }
    );
}

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("autosell:sell").setLabel("Sell").setEmoji("💸").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("autosell:settings").setLabel("Settings").setEmoji("🔑").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("autosell:balance").setLabel("Balance").setEmoji("🧾").setStyle(ButtonStyle.Secondary)
  );
}

// ---------- Client ----------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}.`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    // ----- Slash commands -----
    if (interaction.commandName === "panel") {
  if (!isAdmin(interaction)) return interaction.reply({ content: "Admins only.", ephemeral: true });
  await interaction.channel.send({ embeds: [panelEmbed()], components: [panelRow()] });
  await interaction.reply({ content: "Panel posted.", ephemeral: true });
  return;
    }

      if (interaction.commandName === "setprice") {
        if (!isAdmin(interaction)) return interaction.reply({ content: "Admins only.", ephemeral: true });
        const price = interaction.options.getNumber("usd_per_billion", true);
        data.shop.price_per_billion = price;
        saveData(data);
        await interaction.reply(`Rate set to **${fmtUsd(price)}/1b**.`);
        return;
      }

      if (interaction.commandName === "maxsell") {
        if (!isAdmin(interaction)) return interaction.reply({ content: "Admins only.", ephemeral: true });
        const billions = interaction.options.getNumber("billions", true);
        data.shop.max_sell = billions;
        saveData(data);
        await interaction.reply(`Max sell set to **${fmtBillions(billions)}**.`);
        return;
      }

      if (interaction.commandName === "bal") {
        if (!isAdmin(interaction)) return interaction.reply({ content: "Admins only.", ephemeral: true });
        const usd = interaction.options.getNumber("usd", true);
        data.shop.balance = usd;
        data.shop.open = usd > 0;
        saveData(data);
        const status = data.shop.open ? "open" : "closed (balance is 0)";
        await interaction.reply(`Shop balance set to **${fmtUsd(usd)}** — sells are ${status}.`);
        return;
      }

      if (interaction.commandName === "balance") {
        await interaction.reply({ embeds: [balanceEmbed()] });
        return;
      }
    }

    // ----- Buttons -----
    if (interaction.isButton()) {
      if (interaction.customId === "autosell:sell") {
        if (!data.shop.open) {
          return interaction.reply({
            content: "Sells are closed right now — low balance, needs restock.",
            ephemeral: true,
          });
        }
        const modal = new ModalBuilder()
          .setCustomId("autosell:sellModal")
          .setTitle("Sell In-Game Money")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("amount")
                .setLabel("Amount to sell (in billions, e.g. 2.5)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "autosell:settings") {
        const modal = new ModalBuilder()
          .setCustomId("autosell:settingsModal")
          .setTitle("AutoSell Settings")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("ign")
                .setLabel("Your in-game name (IGN)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(32)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("ltc_address")
                .setLabel("Your LTC receiving address")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(64)
            )
          );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "autosell:balance") {
        await interaction.reply({ embeds: [balanceEmbed()], ephemeral: true });
        return;
      }
    }

    // ----- Modals -----
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "autosell:settingsModal") {
        const uid = interaction.user.id;
        const ign = interaction.fields.getTextInputValue("ign").trim();
        const ltc = interaction.fields.getTextInputValue("ltc_address").trim();
        data.users[uid] = { ign, ltc_address: ltc };
        saveData(data);
        await interaction.reply({
          content: `Saved. IGN: \`${ign}\` · LTC address: \`${ltc}\``,
          ephemeral: true,
        });
        return;
      }

      if (interaction.customId === "autosell:sellModal") {
        const uid = interaction.user.id;
        const user = data.users[uid];
        if (!user || !user.ign || !user.ltc_address) {
          return interaction.reply({
            content: "Save your IGN and LTC address in **Settings** first.",
            ephemeral: true,
          });
        }

        const raw = interaction.fields.getTextInputValue("amount").trim();
        const amountB = Number(raw);
        if (!Number.isFinite(amountB)) {
          return interaction.reply({ content: "Enter a number, e.g. `2.5`.", ephemeral: true });
        }

        const shop = data.shop;
        if (!shop.open) {
          return interaction.reply({
            content: "Sells are closed right now — low balance, needs restock. Open a support ticket or DM staff.",
            ephemeral: true,
          });
        }
        if (shop.max_sell && amountB > shop.max_sell) {
          return interaction.reply({
            content: `That's above the max sell of **${fmtBillions(shop.max_sell)}**.`,
            ephemeral: true,
          });
        }

        const payout = amountB * shop.price_per_billion;
        if (payout > shop.balance) {
          return interaction.reply({
            content: "Shop balance can't cover that right now — try a smaller amount or check back later.",
            ephemeral: true,
          });
        }

        const embed = new EmbedBuilder()
          .setTitle("Sell Order Created")
          .setColor(0x2ecc71)
          .setDescription(
            `Selling **${fmtBillions(amountB)}** at **${fmtUsd(shop.price_per_billion)}/1b** = **${fmtUsd(payout)}**\n\n` +
              `Run this in-game to complete the sale:\n\`\`\`/pay ${BOT_NAME} ${Math.round(amountB * 1_000_000_000)}\`\`\`\n` +
              `Your LTC will be sent to \`${user.ltc_address}\` once the payment is confirmed.`
          );
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
    }
  }
});

(async () => {
  if (!TOKEN || !CLIENT_ID) {
    console.error("Set DISCORD_TOKEN and CLIENT_ID in .env before running.");
    process.exit(1);
  }
  await registerCommands();
  await client.login(TOKEN);
})();
