/**
 * TE HACKS - Discord Destek Botu
 * ------------------------------
 * Özellikler:
 *  - Küfür engelleme sistemi
 *  - Ticket (destek talebi) sistemi -> /ticketkur
 *  - Ticket log sistemi (sarı tema) -> /ticketlog
 *  - Invite (davet) takip sistemi, gerçek/fake üye ayrımı -> /invites
 *  - "Hile Alım" / "Config Alım" ticketlarında seçenek menüsü
 *    (NOT: Bot herhangi bir dosya veya link göndermez. Kullanıcı bir
 *     seçenek seçtiğinde bot sadece "Yetkililer hemen ilgileniyor,
 *     ... hile/config" şeklinde bilgilendirme yazar, gerisini yetkililer
 *     ticket üzerinden manuel olarak halleder.)
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

// Railway (veya başka bir hosting) kullanıyorsan token ve clientId'yi
// "Variables" kısmından ortam değişkeni olarak verebilirsin. Yoksa
// config.json içindeki değerler kullanılır (yerel çalıştırma için).
const TOKEN = process.env.DISCORD_TOKEN || config.token;
const CLIENT_ID = process.env.CLIENT_ID || config.clientId;

// ------------------------------------------------------------------
// BASİT JSON VERİTABANI
// ------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function loadJSON(file, def) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(def, null, 2));
    return def;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return def;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// invitesData: { "inviterId": { invited: [ { id, tag, joinedAt, accountCreatedAt, real } ] } }
let invitesData = loadJSON(INVITES_FILE, {});
// ticketsData: { counter: 0, active: { channelId: { type, openerId, openedAt } } }
let ticketsData = loadJSON(TICKETS_FILE, { counter: 0, active: {} });
// settings: { logChannelId: null }
let settings = loadJSON(SETTINGS_FILE, { logChannelId: config.logChannelId || null });

// ------------------------------------------------------------------
// CLIENT
// ------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Sunucu bazlı davet önbelleği: guildId -> Map(code -> uses)
const inviteCache = new Map();

// Bot tek bir sunucuda çalışacağı için sunucu ID'si otomatik algılanır
let mainGuildId = null;

// Sunucudaki rollerden, config.json'daki isimlere göre yetkili rollerini bulur
function getStaffRoles(guild) {
  const names = (config.staffRoleNames || []).map((n) => n.toLowerCase().trim());
  return guild.roles.cache.filter((role) => names.includes(role.name.toLowerCase().trim()));
}

// ------------------------------------------------------------------
// TICKET TÜRLERİ
// ------------------------------------------------------------------
const TICKET_TYPES = {
  diger: { label: 'Diğer', style: ButtonStyle.Secondary, emoji: '❓', kategori: 'DİĞER' },
  hile_alim: { label: 'Hile Alım', style: ButtonStyle.Danger, emoji: '🎮', kategori: 'HİLE ALIM' },
  config_alim: { label: 'Config Alım', style: ButtonStyle.Success, emoji: '⚙️', kategori: 'CONFIG ALIM' },
  sikayet: { label: 'Şikayet', style: ButtonStyle.Danger, emoji: '⚠️', kategori: 'ŞİKAYET' },
  sorum_var: { label: 'Sorum Var', style: ButtonStyle.Primary, emoji: '❔', kategori: 'SORUM VAR' },
};

// Hile Alım seçenekleri
const HILE_OPTIONS = [
  { id: 'enesbatur', label: 'Enesbatur Hilesi', style: ButtonStyle.Danger },
];

// Config Alım seçenekleri
const CONFIG_OPTIONS = [
  { id: 'catlean', label: 'Catlean Doomsday (Yakında)', style: ButtonStyle.Secondary, disabled: true },
  { id: 'clanware', label: 'Clanware', style: ButtonStyle.Primary },
  { id: 'enesbatur', label: 'Enesbatur', style: ButtonStyle.Success },
];

// Enesbatur config için seviye seçenekleri
const ENESBATUR_LEVELS = [
  { id: 'orta', label: 'Orta Seviye', style: ButtonStyle.Primary },
  { id: 'yuksek', label: 'Yüksek Seviye', style: ButtonStyle.Danger },
];

const SARI_RENK = 0xF1C40F; // ticket log teması - sarı

// ------------------------------------------------------------------
// YARDIMCI FONKSİYONLAR
// ------------------------------------------------------------------
function buildTicketPanelRows() {
  const keys = Object.keys(TICKET_TYPES);
  const rows = [];
  for (let i = 0; i < keys.length; i += 5) {
    const row = new ActionRowBuilder();
    keys.slice(i, i + 5).forEach((key) => {
      const t = TICKET_TYPES[key];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_open_${key}`)
          .setLabel(t.label)
          .setStyle(t.style)
          .setEmoji(t.emoji)
      );
    });
    rows.push(row);
  }
  return rows;
}

function buildOptionRow(prefix, options) {
  const row = new ActionRowBuilder();
  options.forEach((opt) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}_${opt.id}`)
        .setLabel(opt.label)
        .setStyle(opt.style)
        .setDisabled(!!opt.disabled)
    );
  });
  return row;
}

async function createTicketChannel(guild, member, typeKey) {
  const typeInfo = TICKET_TYPES[typeKey];
  ticketsData.counter += 1;
  const num = ticketsData.counter;

  // Discord kanal isimleri: küçük harf, boşluksuz, sadece harf/rakam/tire içerebilir
  const sanitize = (str) =>
    str
      .toLowerCase()
      .replace(/ı/g, 'i')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20) || 'kullanici';

  const isim = sanitize(member.user.username);
  const sebep = typeKey.replace(/_/g, '');
  const channelName = `${isim}-${sebep}-${num}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  const staffRoles = getStaffRoles(guild);
  staffRoles.forEach((role) => {
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  });

  const channelOptions = {
    name: channelName,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
  };
  if (config.ticketCategoryId) channelOptions.parent = config.ticketCategoryId;

  const channel = await guild.channels.create(channelOptions);

  ticketsData.active[channel.id] = {
    type: typeKey,
    kategori: typeInfo.kategori,
    openerId: member.id,
    openedAt: Date.now(),
  };
  saveJSON(TICKETS_FILE, ticketsData);

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Kapat').setStyle(ButtonStyle.Danger).setEmoji('🔒')
  );

  const welcomeEmbed = new EmbedBuilder()
    .setColor(SARI_RENK)
    .setTitle(`${typeInfo.emoji} ${typeInfo.label}`)
    .setDescription(
      `Merhaba <@${member.id}>, destek talebin oluşturuldu.\nYetkililerimiz en kısa sürede seninle ilgilenecektir.`
    )
    .setFooter({ text: `${config.serverName} Destek Sistemi` })
    .setTimestamp();

  await channel.send({ content: `<@${member.id}>`, embeds: [welcomeEmbed], components: [closeRow] });

  // Hile Alım / Config Alım ise ek seçenek menüsü gönder
  if (typeKey === 'hile_alim') {
    await channel.send({
      content: `<@${member.id}> Hangi hileyi alıcaksınız?`,
      components: [buildOptionRow('hilesec', HILE_OPTIONS)],
    });
  } else if (typeKey === 'config_alim') {
    await channel.send({
      content: `<@${member.id}> Hangi configi alıcaksınız?`,
      components: [buildOptionRow('configsec', CONFIG_OPTIONS)],
    });
  }

  return channel;
}

async function generateTranscript(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (!messages || messages.size === 0) return null;
    const sorted = [...messages.values()].reverse();
    const lines = sorted.map((m) => {
      const time = new Date(m.createdTimestamp).toLocaleString('tr-TR');
      const authorTag = m.author?.tag || 'Bilinmiyor';
      const content = m.content || (m.embeds.length ? '[embed]' : '[içerik yok]');
      return `[${time}] ${authorTag}: ${content}`;
    });
    return lines.join('\n');
  } catch {
    return null;
  }
}

async function closeTicket(channel, closerMember) {
  const ticketInfo = ticketsData.active[channel.id];
  if (!ticketInfo) return;

  const opener = await channel.guild.members.fetch(ticketInfo.openerId).catch(() => null);
  const transcriptText = await generateTranscript(channel);

  const logEmbed = new EmbedBuilder()
    .setColor(SARI_RENK)
    .setTitle('🔒 Destek Talebi Kapatıldı ve Arşivlendi')
    .addFields(
      { name: 'Kanal Adı', value: channel.name, inline: false },
      { name: 'Kategori', value: ticketInfo.kategori, inline: false },
      { name: 'Talebi Açan', value: opener ? `<@${opener.id}>` : 'Bilinmiyor', inline: false },
      { name: 'Kapatan Yetkili', value: `<@${closerMember.id}>`, inline: false }
    )
    .setTimestamp();

  let files = [];
  if (!transcriptText) {
    logEmbed.addFields({ name: '📝 Sohbet Geçmişi (Transcript)', value: 'Yazışma bulunamadı.' });
  } else {
    logEmbed.addFields({ name: '📝 Sohbet Geçmişi (Transcript)', value: 'Ektedir.' });
    const buffer = Buffer.from(transcriptText, 'utf-8');
    files = [new AttachmentBuilder(buffer, { name: `${channel.name}-transcript.txt` })];
  }

  if (settings.logChannelId) {
    const logChannel = await channel.guild.channels.fetch(settings.logChannelId).catch(() => null);
    if (logChannel) await logChannel.send({ embeds: [logEmbed], files });
  }

  delete ticketsData.active[channel.id];
  saveJSON(TICKETS_FILE, ticketsData);

  await channel.send('Bu ticket 5 saniye içinde silinecek...');
  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

function isAccountOlderThan30Days(createdTimestamp) {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - createdTimestamp > THIRTY_DAYS_MS;
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/[^a-zçğıöşü\s]/g, '');
}

// ------------------------------------------------------------------
// SLASH KOMUTLARI
// ------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('ticketkur')
    .setDescription('Bu kanala destek talebi (ticket) panelini kurar.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('ticketlog')
    .setDescription('Ticket kapatma loglarının gönderileceği kanalı ayarlar.')
    .addChannelOption((opt) =>
      opt.setName('kanal').setDescription('Log kanalı').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Bir kullanıcının davet istatistiklerini gösterir.')
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Kullanıcı').setRequired(true)),
].map((c) => c.toJSON());

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });
  console.log('✅ Slash komutları kaydedildi.');
}

// ------------------------------------------------------------------
// EVENTLER
// ------------------------------------------------------------------
client.once('ready', async () => {
  console.log(`🤖 ${client.user.tag} olarak giriş yapıldı.`);

  // Bot tek bir sunucuda olacağı için ilk (tek) sunucuyu otomatik algıla
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('❌ Bot hiçbir sunucuya eklenmemiş görünüyor.');
    return;
  }
  mainGuildId = guild.id;
  console.log(`🌐 Sunucu algılandı: ${guild.name} (${guild.id})`);

  await registerCommands(mainGuildId);

  // Yetkili rollerinin bulunup bulunmadığını kontrol et
  const staffRoles = getStaffRoles(guild);
  if (staffRoles.size === 0) {
    console.warn(
      `⚠️ config.json'daki staffRoleNames listesiyle eşleşen rol bulunamadı: [${(config.staffRoleNames || []).join(', ')}]`
    );
  } else {
    console.log(`✅ Yetkili rolleri bulundu: ${staffRoles.map((r) => r.name).join(', ')}`);
  }

  // Sunucunun mevcut davetlerini önbelleğe al
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, new Map(invites.map((inv) => [inv.code, inv.uses])));
  } catch {
    inviteCache.set(guild.id, new Map());
  }
});

// Yeni üye katıldığında hangi davetin kullanıldığını bul
client.on('guildMemberAdd', async (member) => {
  try {
    const guild = member.guild;
    const before = inviteCache.get(guild.id) || new Map();
    const afterInvites = await guild.invites.fetch();
    const after = new Map(afterInvites.map((inv) => [inv.code, inv.uses]));
    inviteCache.set(guild.id, after);

    let usedInvite = null;
    for (const [code, uses] of after.entries()) {
      const beforeUses = before.get(code) || 0;
      if (uses > beforeUses) {
        usedInvite = afterInvites.get(code);
        break;
      }
    }
    if (!usedInvite || !usedInvite.inviter) return;

    const inviterId = usedInvite.inviter.id;
    const real = isAccountOlderThan30Days(member.user.createdTimestamp);

    if (!invitesData[inviterId]) invitesData[inviterId] = { invited: [] };
    invitesData[inviterId].invited.push({
      id: member.id,
      tag: member.user.tag,
      joinedAt: Date.now(),
      accountCreatedAt: member.user.createdTimestamp,
      real,
    });
    saveJSON(INVITES_FILE, invitesData);
  } catch (err) {
    console.error('Invite takip hatası:', err);
  }
});

// Küfür filtresi
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const normalized = normalizeText(message.content);
  const found = config.bannedWords.some((word) => normalized.includes(normalizeText(word)));
  if (found) {
    await message.delete().catch(() => {});
    const warnMsg = await message.channel
      .send(`⚠️ <@${message.author.id}>, lütfen küfür/argo içeren kelimeler kullanma.`)
      .catch(() => null);
    if (warnMsg) setTimeout(() => warnMsg.delete().catch(() => {}), 5000);
  }
});

// Slash komut + buton etkileşimleri
client.on('interactionCreate', async (interaction) => {
  try {
    // ---------------- SLASH KOMUTLARI ----------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticketkur') {
        const embed = new EmbedBuilder()
          .setColor(SARI_RENK)
          .setTitle(`${config.serverName} Destek`)
          .setDescription(
            'Destek talebi açmak için aşağıdaki butonlardan size uygun olanına tıklamanız yeterlidir.\n\n' +
              `**${config.serverName}**'i tercih ettiğiniz için teşekkür ederiz!`
          );
        await interaction.channel.send({ embeds: [embed], components: buildTicketPanelRows() });
        await interaction.reply({ content: '✅ Ticket paneli oluşturuldu.', ephemeral: true });
      }

      if (interaction.commandName === 'ticketlog') {
        const channel = interaction.options.getChannel('kanal');
        settings.logChannelId = channel.id;
        saveJSON(SETTINGS_FILE, settings);
        await interaction.reply({ content: `✅ Ticket logları artık <#${channel.id}> kanalına gönderilecek.`, ephemeral: true });
      }

      if (interaction.commandName === 'invites') {
        const user = interaction.options.getUser('kullanici');
        const data = invitesData[user.id] || { invited: [] };
        const gercek = data.invited.filter((i) => i.real);
        const fake = data.invited.filter((i) => !i.real);

        const embed = new EmbedBuilder()
          .setColor(SARI_RENK)
          .setTitle(`📨 ${user.tag} - Davet İstatistikleri`)
          .addFields(
            { name: 'Toplam Davet', value: `${data.invited.length}`, inline: true },
            { name: '✅ Gerçek Üye', value: `${gercek.length}`, inline: true },
            { name: '❌ Fake Üye', value: `${fake.length}`, inline: true },
            {
              name: '📋 Getirilen Kişiler',
              value:
                data.invited.length === 0
                  ? 'Henüz kimse davet edilmemiş.'
                  : data.invited
                      .map((i) => `${i.real ? '✅' : '❌'} <@${i.id}> (${i.tag})`)
                      .join('\n')
                      .slice(0, 1024),
            }
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
      }
      return;
    }

    // ---------------- BUTONLAR ----------------
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Ticket açma butonları
      if (id.startsWith('ticket_open_')) {
        const typeKey = id.replace('ticket_open_', '');
        if (!TICKET_TYPES[typeKey]) return;

        // aynı kullanıcının açık ticketı var mı kontrolü (basit)
        const existing = Object.entries(ticketsData.active).find(
          ([, v]) => v.openerId === interaction.user.id && v.type === typeKey
        );
        if (existing) {
          await interaction.reply({ content: `⚠️ Zaten açık bir <#${existing[0]}> talebiniz var.`, ephemeral: true });
          return;
        }

        await interaction.reply({ content: '🎫 Talebiniz oluşturuluyor...', ephemeral: true });
        const channel = await createTicketChannel(interaction.guild, interaction.member, typeKey);
        await interaction.editReply({ content: `✅ Talebiniz oluşturuldu: <#${channel.id}>` });
        return;
      }

      // Ticket kapatma
      if (id === 'ticket_close') {
        await interaction.reply({ content: '🔒 Ticket kapatılıyor...' });
        await closeTicket(interaction.channel, interaction.member);
        return;
      }

      // Hile Alım seçenekleri
      if (id.startsWith('hilesec_')) {
        const optId = id.replace('hilesec_', '');
        const opt = HILE_OPTIONS.find((o) => o.id === optId);
        if (!opt) return;
        await interaction.reply({
          content: `Yetkililer hemen ilgileniyor, **${opt.label}**`,
        });
        return;
      }

      // Config Alım seçenekleri
      if (id.startsWith('configsec_')) {
        const optId = id.replace('configsec_', '');

        if (optId === 'enesbatur') {
          await interaction.reply({
            content: 'Enesbatur configi için seviye seçin:',
            components: [buildOptionRow('enesseviye', ENESBATUR_LEVELS)],
          });
          return;
        }

        const opt = CONFIG_OPTIONS.find((o) => o.id === optId);
        if (!opt || opt.disabled) return;
        await interaction.reply({
          content: `Yetkililer hemen ilgileniyor, **${opt.label} config**`,
        });
        return;
      }

      // Enesbatur seviye seçimi
      if (id.startsWith('enesseviye_')) {
        const levelId = id.replace('enesseviye_', '');
        const level = ENESBATUR_LEVELS.find((o) => o.id === levelId);
        if (!level) return;
        await interaction.reply({
          content: `Yetkililer hemen ilgileniyor, **Enesbatur (${level.label}) config**`,
        });
        return;
      }
    }
  } catch (err) {
    console.error('Etkileşim hatası:', err);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: '❌ Bir hata oluştu.', ephemeral: true }).catch(() => {});
    }
  }
});

client.login(TOKEN);
