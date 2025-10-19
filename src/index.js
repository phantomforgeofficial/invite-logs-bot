require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  PermissionsBitField, ChannelType,
  EmbedBuilder, REST, Routes
} = require('discord.js');
const express = require('express');

const {
  ensureFiles, readJSON, writeJSON,
  paths: { INVITE_CACHE_PATH, CONFIG_PATH, STATS_PATH, STATUS_PATH }
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
const UPTIME_CHANNEL_ID = '1429121620194234478'; // <- your required channel for the live status

// ---------- RUNTIME STATE ----------
let invitesCache = {};  // per guild: { code: { uses, inviterId, ... } }
let config = {};        // per guild: { [guildId]: logChannelId }
let stats = {};         // per guild: { [userId]: { total, lastInviteCode } }
let statusStore = {};   // { channelId, messageId } for the live status
let statusInterval = null;

// ---------- UTIL STORAGE ----------
function loadAll() {
  invitesCache = readJSON(INVITE_CACHE_PATH);
  config = readJSON(CONFIG_PATH);
  stats = readJSON(STATS_PATH);
  statusStore = readJSON(STATUS_PATH);
}
function saveInvites(){ writeJSON(INVITE_CACHE_PATH, invitesCache); }
function saveConfig(){ writeJSON(CONFIG_PATH, config); }
function saveStats(){ writeJSON(STATS_PATH, stats); }
function saveStatus(){ writeJSON(STATUS_PATH, statusStore); }

// ---------- HELPERS ----------
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

function buildStatusEmbed() {
  return new EmbedBuilder()
    .setColor(THEME)
    .setTitle('🕒 Phantom Forge Invites Bot Status')
    .setDescription('**Active:** ✅ Online')
    .addFields(
      { name: 'Uptime', value: '`' + formatUptime(process.uptime()) + '`', inline: true },
      { name: 'Ping', value: `${Math.max(0, Math.round(client.ws.ping))} ms`, inline: true },
      { name: 'Last update', value: new Date().toLocaleString('en-US'), inline: false }
    )
    .setFooter({ text: 'Live updated every second | Phantom Forge' })
    .setTimestamp();
}

async function ensureStatusMessage() {
  // Fetch the channel by ID (works across all guilds the bot can see)
  const channel = await client.channels.fetch(UPTIME_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.warn('⚠️ Uptime channel not found or not a text channel. ID:', UPTIME_CHANNEL_ID);
    return null;
  }

  // Try to fetch saved message
  let msg = null;
  if (statusStore.messageId) {
    msg = await channel.messages.fetch(statusStore.messageId).catch(() => null);
  }

  if (!msg) {
    // Send a new status message and remember its ID
    msg = await channel.send({ embeds: [buildStatusEmbed()] });
    statusStore = { channelId: channel.id, messageId: msg.id };
    saveStatus();
  } else {
    // Update the existing one once immediately
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
      if (!msg) {
        await ensureStatusMessage();
        return;
      }
      await msg.edit({ embeds: [buildStatusEmbed()] });
    } catch {
      // swallow transient errors/rate-limits
    }
  }, 1000);
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

  // Cosmetic: set username (rate-limited by Discord)
  try {
    if (client.user.username !== 'Phantom forge Invites') {
      await client.user.setUsername('Phantom forge Invites');
      console.log('✅ Bot name set to "Phantom forge Invites"');
    }
  } catch (e) {
    console.warn('⚠️ Could not change bot name (rate limits/permissions):', e.message);
  }

  // Initialize invite cache for all guilds
  for (const g of client.guilds.cache.values()) {
    await fetchAndStoreInvites(g);
  }

  // Ensure & start the always-on live status
  await ensureStatusMessage();
  startStatusUpdater();

  // Presence
  client.user.setActivity('server invites', { type: 3 }); // Watching
});

// ---------- EVENTS ----------
client.on('guildCreate', async (guild) => {
  await fetchAndStoreInvites(guild);
  if (GUILD_ID && guild.id === GUILD_ID) await registerSlashCommands();
});

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

  // Update stats
  if (!stats[guild.id]) stats[guild.id] = {};
  const inviterId = usedInvite?.inviterId || null;
  if (inviterId) {
    stats[guild.id][inviterId] ??= { total: 0, lastInviteCode: null };
    stats[guild.id][inviterId].total += 1;
    stats[guild.id][inviterId].lastInviteCode = usedInvite.code;
    saveStats();
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
    const gStats = stats[interaction.guildId]?.[user.id];
    const total = gStats?.total ?? 0;
    const code = gStats?.lastInviteCode ? `\`${gStats.lastInviteCode}\`` : '–';

    const embed = new EmbedBuilder()
      .setColor(THEME)
      .setAuthor({ name: `${user.tag}`, iconURL: user.displayAvatarURL() })
      .setTitle('Invite Statistics')
      .addFields(
        { name: 'Total Invited Members', value: String(total), inline: true },
        { name: 'Last Used Code', value: code, inline: true }
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
    const guildId = interaction.guildId;

    const guildStats = stats[guildId] || {};
    const entries = Object.entries(guildStats);

    if (entries.length === 0) {
      return interaction.reply({ content: 'No invite statistics available yet.', ephemeral: true });
    }

    const top = entries
      .sort((a, b) => (b[1]?.total ?? 0) - (a[1]?.total ?? 0))
      .slice(0, amount);

    const lines = top.map(([userId, s], i) => {
      const place = i + 1;
      const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : `#${place}`;
      const total = s?.total ?? 0;
      return `${medal} <@${userId}> — **${total}** invites`;
    });

    const embed = new EmbedBuilder()
      .setColor(THEME)
      .setTitle('🏆 Invite Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Top ${lines.length} • Server: ${interaction.guild.name}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
});

// ---------- LOGIN ----------
client.login(TOKEN);

// ---------- EXPRESS KEEP-ALIVE (Render Free) ----------
const app = express();
app.get('/', (_req, res) => res.send('✅ Phantom Forge Invites bot is online and running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
