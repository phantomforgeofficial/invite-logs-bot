require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  PermissionsBitField, ChannelType,
  EmbedBuilder, REST, Routes
} = require('discord.js');

const {
  ensureFiles, readJSON, writeJSON,
  paths: { INVITE_CACHE_PATH, CONFIG_PATH, STATS_PATH }
} = require('./storage');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Zet DISCORD_TOKEN en CLIENT_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

// in-memory state
let invitesCache = {};
let config = {};
let stats = {};

function loadAll() {
  invitesCache = readJSON(INVITE_CACHE_PATH);
  config = readJSON(CONFIG_PATH);
  stats = readJSON(STATS_PATH);
}
function saveInvites(){ writeJSON(INVITE_CACHE_PATH, invitesCache); }
function saveConfig(){ writeJSON(CONFIG_PATH, config); }
function saveStats(){ writeJSON(STATS_PATH, stats); }

function getLogChannel(guild) {
  const cfgId = config[guild.id];
  if (cfgId) return guild.channels.cache.get(cfgId) ?? null;
  const fallback = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildText && ch.name.toLowerCase() === 'invite-logs'
  );
  return fallback ?? null;
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
    console.warn(`[${guild.name}] invites.fetch() faalde: ${e.message}`);
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

const commands = [
  {
    name: 'setinvitelog',
    description: 'Stel het kanaal voor invite logs in',
    default_member_permissions: (PermissionsBitField.Flags.ManageGuild).toString(),
    options: [
      {
        type: 7, // CHANNEL
        name: 'kanaal',
        description: 'Tekstkanaal voor logs',
        channel_types: [ChannelType.GuildText],
        required: true
      }
    ]
  },
  {
    name: 'invites',
    description: 'Bekijk invite stats (zonder user = jijzelf)',
    options: [
      {
        type: 6, // USER
        name: 'gebruiker',
        description: 'Optioneel: kies een gebruiker',
        required: false
      }
    ]
  },
  {
    name: 'avatar',
    description: 'Toon de avatar van een gebruiker (zonder user = jijzelf)',
    options: [
      {
        type: 6, // USER
        name: 'gebruiker',
        description: 'Optioneel: kies een gebruiker',
        required: false
      }
    ]
  },
  {
    name: 'lb',
    description: 'Leaderboard: meeste invites (optioneel: aantal)',
    options: [
      {
        type: 4, // INTEGER
        name: 'aantal',
        description: 'Hoeveel posities (3–25, standaard 10)',
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
      console.log(`✅ Guild commands geregistreerd in guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✅ Global commands geregistreerd (kan even duren om te verschijnen)');
    }
  } catch (e) {
    console.error('Fout bij registreren commands:', e);
  }
}

client.once('ready', async () => {
  console.log(`🤖 Ingelogd als ${client.user.tag}`);
  await ensureFiles();
  loadAll();
  await registerSlashCommands();

  // Probeer botnaam te zetten (rate-limited door Discord, dus try/catch)
  (async () => {
    try {
      if (client.user.username !== 'Phantom forge Invites') {
        await client.user.setUsername('Phantom forge Invites');
        console.log('✅ Botnaam gezet naar "Phantom forge Invites"');
      }
    } catch (e) {
      console.warn('⚠️ Kon botnaam niet wijzigen (rate limits/permissions):', e.message);
    }
  })();

  // init invite-cache
  for (const g of client.guilds.cache.values()) {
    await fetchAndStoreInvites(g);
  }
});

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

  // Log naar kanaal
  const logCh = getLogChannel(guild);
  if (logCh && logCh.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)) {
    const emb = new EmbedBuilder()
      .setColor(0x8367F7)
      .setTimestamp()
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .setAuthor({ name: `${member.user.tag} joined`, iconURL: member.user.displayAvatarURL() });

    if (usedInvite) {
      emb.setDescription(
        `👤 **Member:** ${member}\n` +
        `🔗 **Invite:** \`${usedInvite.code}\`\n` +
        `👑 **Uitnodiger:** ${inviterId ? `<@${inviterId}>` : '`onbekend`'}\n` +
        `#️⃣ **Kanaal:** ${usedInvite.channelId ? `<#${usedInvite.channelId}>` : '`onbekend`'}\n` +
        `♻️ **Gebruik:** ${usedInvite.uses ?? 0}/${usedInvite.maxUses ?? '∞'}\n` +
        (usedInvite.expiresAt ? `⏰ **Verloopt:** <t:${Math.floor(usedInvite.expiresAt/1000)}:R>\n` : '')
      ).setFooter({ text: `Gebruikte invite: ${usedInvite.code}` });
    } else if (usedVanity) {
      emb.setDescription(`👤 **Member:** ${member}\n✨ **Vanity URL** gebruikt`);
    } else {
      emb.setDescription(`👤 **Member:** ${member}\n❓ Invite niet kunnen bepalen (permissies/weggegooide invite).`);
    }

    logCh.send({ embeds: [emb] }).catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /setinvitelog
  if (interaction.commandName === 'setinvitelog') {
    const ch = interaction.options.getChannel('kanaal', true);
    if (ch.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'Kies een **tekstkanaal**.', ephemeral: true });
    }
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'Je mist **Manage Server**.', ephemeral: true });
    }
    config[interaction.guildId] = ch.id;
    saveConfig();
    return interaction.reply({ content: `✅ Invite logs kanaal ingesteld op ${ch}.`, ephemeral: true });
  }

  // /invites [gebruiker]
  if (interaction.commandName === 'invites') {
    const user = interaction.options.getUser('gebruiker') ?? interaction.user;
    const gStats = stats[interaction.guildId]?.[user.id];
    const total = gStats?.total ?? 0;
    const code = gStats?.lastInviteCode ? `\`${gStats.lastInviteCode}\`` : '–';

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setAuthor({ name: `${user.tag}`, iconURL: user.displayAvatarURL() })
      .setTitle('Invite stats')
      .addFields(
        { name: 'Totaal members uitgenodigd', value: String(total), inline: true },
        { name: 'Laatst gebruikte code', value: code, inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // /avatar [gebruiker]
  if (interaction.commandName === 'avatar') {
    const user = interaction.options.getUser('gebruiker') ?? interaction.user;
    const url = user.displayAvatarURL({ size: 1024, extension: 'png', forceStatic: false });

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setAuthor({ name: `${user.tag}`, iconURL: user.displayAvatarURL() })
      .setTitle('Avatar')
      .setImage(url)
      .setFooter({ text: `Gebruiker ID: ${user.id}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // /lb [aantal]
  if (interaction.commandName === 'lb') {
    const amount = interaction.options.getInteger('aantal') ?? 10;
    const guildId = interaction.guildId;

    const guildStats = stats[guildId] || {};
    const entries = Object.entries(guildStats); // [ [userId, { total, lastInviteCode }], ... ]

    if (entries.length === 0) {
      return interaction.reply({ content: 'Er zijn nog geen invite-statistieken beschikbaar.', ephemeral: true });
    }

    const top = entries
      .sort((a, b) => (b[1]?.total ?? 0) - (a[1]?.total ?? 0))
      .slice(0, amount);

    const lines = top.map(([userId, s], i) => {
      const place = i + 1;
      const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : `#${place}`;
      const total = s?.total ?? 0;
      return `${medal} <@${userId}> — **${total}**`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('🏆 Invite Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Top ${lines.length} • Server: ${interaction.guild.name}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
});

client.login(TOKEN);
