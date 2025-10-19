require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  PermissionsBitField, ChannelType,
  EmbedBuilder, REST, Routes
} = require('discord.js');
const express = require('express');

const {
  ensureFiles, readJSON, writeJSON,
  paths: { INVITE_CACHE_PATH, CONFIG_PATH, STATS_PATH, STATUS_PATH, MEMBERS_PATH }
} = require('./storage');

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null; // optional, speeds up command registration

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Please set DISCORD_TOKEN and CLIENT_ID in your environment.');
  process.exit(1);
}

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

// ---------- CONSTANTS ----------
const THEME = 0x8000ff; // #8000ff
const UPTIME_CHANNEL_ID = '1429121620194234478'; // live status channel

// ---------- RUNTIME STATE ----------
let invitesCache = {};   // per guild: { code: {...} }
let config = {};         // per guild: { [guildId]: logChannelId }
let stats = {};          // per guild: { [userId]: { joins, leaves, bonus, lastInviteCode } }
let statusStore = {};    // { channelId, messageId }
let membersMap = {};     // per guild: { [memberId]: inviterId }
let statusInterval = null;

// ---------- STORAGE HELPERS ----------
function loadAll() {
  invitesCache = readJSON(INVITE_CACHE_PATH);
  config = readJSON(CONFIG_PATH);
  stats = readJSON(STATS_PATH);
  statusStore = readJSON(STATUS_PATH);
  membersMap = readJSON(MEMBERS_PATH);
  migrateOldStatsSchema();
}
function saveInvites(){ writeJSON(INVITE_CACHE_PATH, invitesCache); }
function saveConfig(){ writeJSON(CONFIG_PATH, config); }
function saveStats(){ writeJSON(STATS_PATH, stats); }
function saveStatus(){ writeJSON(STATUS_PATH, statusStore); }
function saveMembers(){ writeJSON(MEMBERS_PATH, membersMap); }

// Migrate older { total } schema -> { joins, leaves, bonus }
function migrateOldStatsSchema() {
  let changed = false;
  for (const [gid, byUser] of Object.entries(stats)) {
    for (const [uid, s] of Object.entries(byUser)) {
      if (s && typeof s === 'object' && s.total != null && s.joins == null) {
        const total = Number(s.total) || 0;
        stats[gid][uid] = {
          joins: total,
          leaves: 0,
          bonus: 0,
          lastInviteCode: s.lastInviteCode ?? null
        };
        changed = true;
      } else {
        stats[gid][uid] ??= {};
        stats[gid][uid].joins ??= 0;
        stats[gid][uid].leaves ??= 0;
        stats[gid][uid].bonus ??= 0;
        if (!('lastInviteCode' in stats[gid][uid])) stats[gid][uid].lastInviteCode = null;
      }
    }
  }
  if (changed) saveStats();
}

// ---------- UTILS ----------
function getLogChannel(guild) {
  const cfgId = config[guild.id];
  if (cfgId) return guild.channels.cache.get(cfgId) ?? null;
  return guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildText && ch.name.toLowerCase() === 'invite-logs'
  ) ?? null;
}

async function fetchAndStoreInvites(guild) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
  try {
    const invites = await guild.invites.fetch();
    if (!invitesCache[guild.id]) invitesCache[guild.id] = {};
    for (const inv of invites.values()) {
      invitesCache[guild.id][inv.code] = {
        uses: inv.uses ?? 0,
        inviterId: inv.inviter?.id ?? null,
        channelId: inv.channelId ?? null,
        maxUses: inv.maxUses ?? null,
        createdTimestamp: inv.createdTimestamp ?? null,
        expiresAt: inv.expiresAt ? inv.expiresAt.getTime() : null,
      };
    }
    saveInvites();
  } catch (e) {
    console.warn(`[${guild.name}] Could not fetch invites: ${e.message}`);
  }
}

async function getVanityUsesSafe(guild) {
  try {
    const v = await guild.fetchVanityData();
    return v?.uses ?? 0;
  } catch {
    return null;
  }
}

function formatUptime(seconds) {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ✅ Status embed: "Active:" on one line, "✅ Online" on the next + footer icon
function buildStatusEmbed() {
  const footerIcon = client.user.displayAvatarURL({ size: 64 });
  return new EmbedBuilder()
    .setColor(THEME)
    .setTitle('🕒 Phantom Forge Invites Bot Status')
    .setDescription('**Active:**\n✅ Online')
    .addFields(
      { name: 'Uptime', value: '`' + formatUptime(process.uptime()) + '`', inline: true },
      { name: 'Ping', value: `${Math.max(0, Math.round(client.ws.ping))} ms`, inline: true },
      { name: 'Last update', value: new Date().toLocaleString('en-US'), inline: false }
    )
    .setFooter({ text: 'Live updated every second | Phantom Forge', iconURL: footerIcon })
    .setTimestamp();
}

async function ensureStatusMessage() {
  const channel = await client.channels.fetch(UPTIME_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.warn('⚠️ Uptime channel not found or not a text channel. ID:', UPTIME_CHANNEL_ID);
    return null;
  }
  let msg = null;
  if (statusStore.messageId) {
    msg = await channel.messages.fetch(statusStore.messageId).catch(() => null);
  }
  if (!msg) {
    msg = await channel.send({ embeds: [buildStatusEmbed()] });
    statusStore = { channelId: channel.id, messageId: msg.id };
    saveStatus();
  } else {
    await msg.edit({ embeds: [buildStatusEmbed()] });
  }
  return { channel, msg };
}

function startStatusUpdater() {
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(async () => {
    try {
      if (!statusStore.channelId || !statusStore.messageId) {
        await ensureStatusMessage();
        return;
      }
      const channel = await client.channels.fetch(statusStore.channelId).catch(() => null);
      if (!channel) return;
      const msg = await channel.messages.fetch(statusStore.messageId).catch(() => null);
      if (!msg) { await ensureStatusMessage(); return; }
      await msg.edit({ embeds: [buildStatusEmbed()] });
    } catch { /* ignore transient errors */ }
  }, 1000);
}

function computeTotal(s) {
  const joins = s?.joins ?? 0;
  const leaves = s?.leaves ?? 0;
  const bonus = s?.bonus ?? 0;
  return joins - leaves + bonus;
}

// Presence helper — Watching (server name)
async function setWatchingPresence() {
  try {
    const ch = await client.channels.fetch(UPTIME_CHANNEL_ID).catch(() => null);
    const guildName = ch?.guild?.name || 'server invites';
    await client.user.setActivity(guildName, { type: 3 }); // 3 = Watching
  } catch {
    client.user.setActivity('server invites', { type: 3 });
  }
}

// ---------- SLASH COMMANDS ----------
const commands = [
  {
    name: 'setinvitelog',
    description: 'Set the channel for invite logs',
    default_member_permissions: (PermissionsBitField.Flags.ManageGuild).toString(),
    options: [
      {
        type: 7,
        name: 'channel',
        description: 'Text channel for logs',
        channel_types: [ChannelType.GuildText],
        required: true
      }
    ]
  },
  {
    name: 'invites',
    description: 'Show invite stats (no user = yourself)',
    options: [
      {
        type: 6,
        name: 'user',
        description: 'Optional: choose a user',
        required: false
      }
    ]
  },
  {
    name: 'avatar',
    description: 'Show the avatar of a user (no user = yourself)',
    options: [
      {
        type: 6,
        name: 'user',
        description: 'Optional: choose a user',
        required: false
      }
    ]
  },
  {
    name: 'lb',
    description: 'Leaderboard: most invites (optional amount)',
    options: [
      {
        type: 4,
        name: 'amount',
        description: 'How many positions (3–25, default 10)',
        required: false,
        min_value: 3,
        max_value: 25
      }
    ]
  },
  {
    name: 'bonus',
    description: 'Add or subtract bonus invites for a user',
    default_member_permissions: (PermissionsBitField.Flags.ManageGuild).toString(),
    options: [
      {
        type: 6,
        name: 'user',
        description: 'User to modify',
        required: true
      },
      {
        type: 4,
        name: 'amount',
        description: 'Amount to add (use negative to subtract)',
        required: true
      }
    ]
  }
];

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Slash commands registered in guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✅ Global slash commands registered (may take up to 1 hour to appear)');
    }
  } catch (e) {
    console.error('Error registering slash commands:', e);
  }
}

// ---------- READY ----------
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await ensureFiles();
  loadAll();
  await registerSlashCommands();

  // Cosmetic: set username (rate-limited)
  try {
    if (client.user.username !== 'Phantom forge Invites') {
      await client.user.setUsername('Phantom forge Invites');
      console.log('✅ Bot name set to "Phantom forge Invites"');
    }
  } catch (e) {
    console.warn('⚠️ Could not change bot name (rate limits/permissions):', e.message);
  }

  // Init invite cache
  for (const g of client.guilds.cache.values()) {
    await fetchAndStoreInvites(g);
  }

  // Start live status
  await ensureStatusMessage();
  startStatusUpdater();

  // Presence: Watching (server name)
  await setWatchingPresence();
});

client.on('guildCreate', async (guild) => {
  await fetchAndStoreInvites(guild);
  if (GUILD_ID && guild.id === GUILD_ID) await registerSlashCommands();
  await setWatchingPresence();
});

client.on('guildDelete', setWatchingPresence);

// ---------- EVENTS ----------
client.on('inviteCreate', async (invite) => {
  const g = invite.guild;
  if (!invitesCache[g.id]) invitesCache[g.id] = {};
  invitesCache[g.id][invite.code] = {
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id ?? null,
    channelId: invite.channelId ?? null,
    maxUses: invite.maxUses ?? null,
    createdTimestamp: invite.createdTimestamp ?? null,
    expiresAt: invite.expiresAt ? invite.expiresAt.getTime() : null,
  };
  saveInvites();
});

client.on('inviteDelete', async (invite) => {
  const g = invite.guild;
  if (invitesCache[g.id]) {
    delete invitesCache[g.id][invite.code];
    saveInvites();
  }
});

client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;
  const beforeVanity = await getVanityUsesSafe(guild);
  const before = invitesCache[guild.id] ? new Map(Object.entries(invitesCache[guild.id])) : new Map();

  await fetchAndStoreInvites(guild);
  const after = invitesCache[guild.id] ? new Map(Object.entries(invitesCache[guild.id])) : new Map();

  let usedInvite = null;
  for (const [code, a] of after.entries()) {
    const b = before.get(code);
    if ((a.uses ?? 0) > (b?.uses ?? 0)) {
      usedInvite = { code, ...a };
      break;
    }
  }

  let usedVanity = false;
  if (!usedInvite && beforeVanity !== null) {
    const afterVanity = await getVanityUsesSafe(guild);
    if (afterVanity !== null && afterVanity > beforeVanity) usedVanity = true;
  }

  // Update stats & remember inviter for this member
  if (!stats[guild.id]) stats[guild.id] = {};
  if (!membersMap[guild.id]) membersMap[guild.id] = {};

  const inviterId = usedInvite?.inviterId || null;
  if (inviterId) {
    stats[guild.id][inviterId] ??= { joins: 0, leaves: 0, bonus: 0, lastInviteCode: null };
    stats[guild.id][inviterId].joins += 1;
    stats[guild.id][inviterId].lastInviteCode = usedInvite.code;
    membersMap[guild.id][member.id] = inviterId;
    saveStats();
    saveMembers();
  }

  // Log to channel (if configured)
  const logCh = getLogChannel(guild);
  if (logCh && logCh.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)) {
    const emb = new EmbedBuilder()
      .setColor(THEME)
      .setTimestamp()
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .setAuthor({ name: `${member.user.tag} joined`, iconURL: member.user.displayAvatarURL() });

    if (usedInvite) {
      emb.setDescription(
        `👤 **Member:** ${member}\n` +
        `🔗 **Invite Code:** \`${usedInvite.code}\`\n` +
        `👑 **Inviter:** ${inviterId ? `<@${inviterId}>` : '`Unknown`'}\n` +
        `#️⃣ **Channel:** ${usedInvite.channelId ? `<#${usedInvite.channelId}>` : '`Unknown`'}\n` +
        `♻️ **Uses:** ${usedInvite.uses ?? 0}/${usedInvite.maxUses ?? '∞'}\n` +
        (usedInvite.expiresAt ? `⏰ **Expires:** <t:${Math.floor(usedInvite.expiresAt/1000)}:R>\n` : '')
      ).setFooter({ text: `Invite used: ${usedInvite.code}` });
    } else if (usedVanity) {
      emb.setDescription(`👤 **Member:** ${member}\n✨ Used the vanity URL invite.`);
    } else {
      emb.setDescription(`👤 **Member:** ${member}\n❓ Could not determine which invite was used.`);
    }

    logCh.send({ embeds: [emb] }).catch(() => {});
  }
});

// Track leaves → increment "leaves" for the original inviter
client.on('guildMemberRemove', async (member) => {
  const guildId = member.guild.id;
  const gMap = membersMap[guildId] || {};
  const inviterId = gMap[member.id];
  if (!inviterId) return;
  stats[guildId] ??= {};
  stats[guildId][inviterId] ??= { joins: 0, leaves: 0, bonus: 0, lastInviteCode: null };
  stats[guildId][inviterId].leaves += 1;
  saveStats();
  // Optionally: delete membersMap[guildId][member.id]; saveMembers();
});

// ---------- INTERACTIONS ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setinvitelog') {
    const ch = interaction.options.getChannel('channel', true);
    if (ch.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'Please select a **text channel**.', ephemeral: true });
    }
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need **Manage Server** permission to use this command.', ephemeral: true });
    }
    config[interaction.guildId] = ch.id;
    saveConfig();
    return interaction.reply({ content: `✅ Invite logs channel set to ${ch}.`, ephemeral: true });
  }

  if (interaction.commandName === 'invites') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const s = stats[interaction.guildId]?.[user.id] ?? { joins: 0, leaves: 0, bonus: 0 };
    const total = computeTotal(s);

    const embed = new EmbedBuilder()
      .setColor(THEME)
      .setAuthor({ name: `${user.tag}`, iconURL: user.displayAvatarURL() })
      .setDescription(`**${total} Invites**`)
      .addFields(
        { name: '🟩 Joins', value: `**${s.joins}**`, inline: true },
        { name: '🟥 Leaves', value: `**${s.leaves}**`, inline: true },
        { name: '✨ Bonus', value: `**${s.bonus}**`, inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'avatar') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const url = user.displayAvatarURL({ size: 1024, extension: 'png', forceStatic: false });

    const embed = new EmbedBuilder()
      .setColor(THEME)
      .setAuthor({ name: `${user.tag}`, iconURL: user.displayAvatarURL() })
      .setTitle('Avatar')
      .setImage(url)
      .setFooter({ text: `User ID: ${user.id}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'lb') {
    const amount = interaction.options.getInteger('amount') ?? 10;
    const g = stats[interaction.guildId] || {};
    const entries = Object.entries(g);
    if (entries.length === 0) {
      return interaction.reply({ content: 'No invite statistics available yet.', ephemeral: true });
    }

    const top = entries
      .map(([uid, s]) => [uid, computeTotal(s)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, amount);

    const lines = top.map(([uid, total], i) => {
      const place = i + 1;
      const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : `#${place}`;
      return `${medal} <@${uid}> — **${total}** invites`;
    });

    const embed = new EmbedBuilder()
      .setColor(THEME)
      .setTitle('🏆 Invite Leaderboard')
      .setDescription(lines.join('\n'))
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'bonus') {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need **Manage Server** permission to use this command.', ephemeral: true });
    }
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    stats[interaction.guildId] ??= {};
    stats[interaction.guildId][user.id] ??= { joins: 0, leaves: 0, bonus: 0, lastInviteCode: null };
    stats[interaction.guildId][user.id].bonus += amount;
    saveStats();

    const s = stats[interaction.guildId][user.id];
    const total = computeTotal(s);

    const embed = new EmbedBuilder()
      .setColor(THEME)
      .setTitle('Bonus Updated')
      .setDescription(`Updated bonus for ${user}: **${amount > 0 ? `+${amount}` : amount}**`)
      .addFields(
        { name: '🟩 Joins', value: `**${s.joins}**`, inline: true },
        { name: '🟥 Leaves', value: `**${s.leaves}**`, inline: true },
        { name: '✨ Bonus', value: `**${s.bonus}**`, inline: true },
        { name: 'Total', value: `**${total}**`, inline: false }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ---------- LOGIN ----------
client.login(TOKEN);

// ---------- EXPRESS KEEP-ALIVE (Render Free) ----------
const app = express();
app.get('/', (_req, res) => res.send('✅ Phantom Forge Invites bot is online and running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
