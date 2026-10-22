require('dotenv').config();

const express = require('express');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');

const app = express();
app.use(express.json({ limit: '100kb' }));

const token = process.env.DISCORD_TOKEN;
const apiKey = process.env.API_KEY;
const websiteApi = (process.env.WEBSITE_API_URL || '').trim();
const discordClientId = process.env.DISCORD_CLIENT_ID;
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET;
const discordRedirectUri =
  process.env.DISCORD_REDIRECT_URI ||
  'https://dibiaa.free.nf/discord-callback.php';

const ticketCategoryId = (process.env.TICKET_CATEGORY_ID || '').trim();
const supportRoleId = (process.env.SUPPORT_ROLE_ID || '').trim();

// InfinityFree's free-hosting browser challenge blocks non-browser API requests.
// Keep panel data in memory when the website asks the bot to publish a panel.
const panelCache = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

function authorized(req) {
  return Boolean(apiKey && req.get('X-API-Key') === apiKey);
}

function looksLikeSecurityChallenge(body) {
  const text = String(body || '').toLowerCase();
  return text.includes('/aes.js') ||
    text.includes('this site requires javascript') ||
    text.includes('__test');
}

async function saveToWebsite(data) {
  if (!websiteApi) throw new Error('WEBSITE_API_URL missing');
  if (!apiKey) throw new Error('API_KEY missing');

  const response = await fetch(websiteApi, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(8000)
  });

  const body = await response.text();
  let result = {};
  try {
    result = JSON.parse(body);
  } catch {
    // A security challenge is HTML, not a JSON API response.
  }

  if (looksLikeSecurityChallenge(body)) {
    throw new Error(
      'InfinityFree security challenge blocked the Render API request. ' +
      'The request returned /aes.js HTML instead of JSON.'
    );
  }

  if (!response.ok || !result.ok) {
    throw new Error(
      `Website API failed (HTTP ${response.status}): ` +
      `${result.error || body.slice(0, 180) || 'Empty response'}`
    );
  }
  return result;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Dibiaa Hub Discord Bot',
    botReady: client.isReady(),
    cachedPanels: panelCache.size
  });
});

// Ticket dashboard endpoint: PHP requests this from the browser-facing website,
// then stores the returned ticket rows in its own MySQL database.
app.get('/tickets/list', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const guildId = String(req.query.guild_id || '');
  if (!/^\d{15,22}$/.test(guildId)) {
    return res.status(400).json({ ok: false, error: 'Valid guild_id required' });
  }
  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const tickets = [];
    for (const channel of channels.values()) {
      if (!channel || !channel.isTextBased() || !channel.topic ||
          !channel.topic.includes('Dibiaa ticket | User ID:')) continue;
      const userMatch = channel.topic.match(/User ID:\s*(\d+)/);
      if (!userMatch) continue;
      let messageDescription = '';
      let embedTitle = channel.name || 'Discord Ticket';
      try {
        const messages = await channel.messages.fetch({ limit: 25 });
        const botMessage = messages.find(m => m.author.id === client.user.id && m.embeds.length);
        if (botMessage && botMessage.embeds[0]) {
          const embed = botMessage.embeds[0];
          embedTitle = embed.title || embedTitle;
          messageDescription = embed.description || '';
        }
      } catch (err) {
        console.error('Ticket channel read failed:', channel.id, err.message);
      }
      tickets.push({
        title: embedTitle,
        description: messageDescription || 'Ticket created in Discord.',
        discord_user_id: userMatch[1],
        discord_channel_id: channel.id,
        guild_id: guildId,
        status: channel.name.startsWith('closed-') ? 'closed' : 'open',
        created_at: channel.createdAt.toISOString().slice(0, 19).replace('T', ' ')
      });
    }
    return res.json({ ok: true, tickets });
  } catch (error) {
    console.error('Ticket list error:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load tickets from Discord.' });
  }
});

// Channel and role choices for the panel builder. Data comes from the connected Discord server.
app.get('/guilds/:guildId/channels', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const guildId = String(req.params.guildId || '');
  if (!/^\d{15,22}$/.test(guildId)) return res.status(400).json({ ok: false, error: 'Valid guild ID required' });
  try {
    const guild = await client.guilds.fetch(guildId);
    const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch().catch(() => null)]);
    return res.json({
      ok: true,
      channels: [...channels.values()].filter(c => c && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory].includes(c.type)).map(c => ({ id: c.id, name: c.name, type: c.type, parent_id: c.parentId || null })),
      roles: roles ? [...roles.values()].filter(r => !r.managed && r.id !== guild.id).map(r => ({ id: r.id, name: r.name, position: r.position })).sort((a,b) => b.position-a.position) : []
    });
  } catch (error) {
    console.error('Guild channel lookup failed:', error.message);
    return res.status(502).json({ ok: false, error: 'Could not load channels. Check bot membership and View Channels permission.' });
  }
});

// OAuth code exchange. The PHP callback must validate OAuth state first.
app.post('/oauth/discord/exchange', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!discordClientId || !discordClientSecret) {
    return res.status(500).json({
      ok: false,
      error: 'Discord OAuth environment variables are missing'
    });
  }

  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const redirectUri =
    typeof req.body?.redirect_uri === 'string'
      ? req.body.redirect_uri.trim()
      : '';

  if (!code || code.length > 2048) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid authorization code' });
  }
  if (redirectUri !== discordRedirectUri) {
    return res.status(400).json({ ok: false, error: 'Invalid redirect URI' });
  }

  try {
    const form = new URLSearchParams({
      client_id: discordClientId,
      client_secret: discordClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: discordRedirectUri
    });

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15000)
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('Discord OAuth token exchange failed. HTTP:', tokenResponse.status);
      return res.status(502).json({
        ok: false,
        error: 'Discord authorization failed. Please log in again.'
      });
    }

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const [userResponse, guildResponse] = await Promise.all([
      fetch('https://discord.com/api/v10/users/@me', {
        headers, signal: AbortSignal.timeout(15000)
      }),
      fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers, signal: AbortSignal.timeout(15000)
      })
    ]);
    const user = await userResponse.json().catch(() => ({}));
    const guilds = await guildResponse.json().catch(() => []);

    if (!userResponse.ok || !user.id || !guildResponse.ok || !Array.isArray(guilds)) {
      return res.status(502).json({
        ok: false,
        error: 'Could not load Discord profile or servers'
      });
    }

    const manageableGuilds = guilds.filter(guild => {
      try {
        const permissions = BigInt(guild.permissions || '0');
        return guild.owner === true ||
          (permissions & 0x20n) !== 0n ||
          (permissions & 0x8n) !== 0n;
      } catch {
        return false;
      }
    }).map(guild => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon || null,
      owner: guild.owner === true,
      permissions: guild.permissions
    }));

    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        global_name: user.global_name || null,
        avatar: user.avatar || null
      },
      guilds: manageableGuilds
    });
  } catch (error) {
    console.error('OAuth exchange error:', error.message);
    return res.status(502).json({
      ok: false,
      error: 'Could not contact Discord. Please try again.'
    });
  }
});

// Website calls this endpoint to publish a panel. Cache the panel's questions
// here so the Discord button does not need a Render -> InfinityFree API call.
app.post('/publish-panel', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const {
      panel_id, guild_id, channel_id, title, description, questions, settings = {}
    } = req.body || {};

    const id = String(panel_id || '');
    if (
      !/^\d+$/.test(id) ||
      !guild_id ||
      !channel_id ||
      !title ||
      !Array.isArray(questions) ||
      questions.length < 1 ||
      questions.length > 5 ||
      questions.some(q => typeof q !== 'string' || !q.trim())
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Missing fields or invalid questions (1-5).'
      });
    }

    if (!client.isReady()) {
      return res.status(503).json({ ok: false, error: 'Discord bot is not ready yet.' });
    }

    const guild = await client.guilds.fetch(String(guild_id));
    const channel = await guild.channels.fetch(String(channel_id));

    if (!channel || !channel.isTextBased() || !channel.send) {
      return res.status(400).json({
        ok: false,
        error: 'Channel not found or not a text channel.'
      });
    }

    const safeSettings = settings && typeof settings === 'object' ? settings : {};
    const safePanel = {
      id, guild_id: String(guild_id),
      title: String(title).slice(0, 256),
      description: String(description || 'Click below to open a ticket.').slice(0, 4000),
      questions: questions.map(q => String(q).trim().slice(0, 200)),
      settings: safeSettings
    };
    const colourText = /^#[0-9a-fA-F]{6}$/.test(String(safeSettings.panel_colour || '')) ? String(safeSettings.panel_colour) : '#e11d48';
    const packed = deflateRawSync(Buffer.from(JSON.stringify(safePanel))).toString('base64url');
    const footerText = ('Dibiaa Hub • Ticket Panel • DH1:' + packed).slice(0, 2048);
    const embed = new EmbedBuilder()
      .setTitle(safePanel.title)
      .setDescription(safePanel.description)
      .setColor(colourText)
      .setFooter({ text: footerText });
    if (/^https:\/\//i.test(String(safeSettings.thumbnail_url || ''))) embed.setThumbnail(String(safeSettings.thumbnail_url).slice(0, 500));
    if (/^https:\/\//i.test(String(safeSettings.image_url || ''))) embed.setImage(String(safeSettings.image_url).slice(0, 500));
    const styleMap = { Primary: ButtonStyle.Primary, Secondary: ButtonStyle.Secondary, Success: ButtonStyle.Success, Danger: ButtonStyle.Danger };
    const button = new ButtonBuilder().setCustomId('dh_open:' + id).setLabel(String(safeSettings.button_text || 'Open Ticket').slice(0, 80)).setStyle(styleMap[safeSettings.button_colour] || ButtonStyle.Danger);
    const emoji = String(safeSettings.button_emoji || '').trim();
    if (emoji && emoji.length <= 20) { try { button.setEmoji(emoji); } catch {} }
    const row = new ActionRowBuilder().addComponents(button);

    const message = await channel.send({ embeds: [embed], components: [row] });
    panelCache.set(id, safePanel);

    // Do not call the InfinityFree API from Render here. The website already
    // saved the panel before calling /publish-panel; this avoids the false
    // "publish failed" message caused by InfinityFree's /aes.js challenge.
    console.log(`Panel ${id} published and cached. Discord message: ${message.id}`);

    return res.json({
      ok: true,
      message_id: message.id,
      channel_id: channel.id,
      note: 'Panel data cached in bot memory. Re-publish after a bot restart if needed.'
    });
  } catch (error) {
    console.error('Panel publish error:', error.message);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Panel publish failed'
    });
  }
});

async function createPrivateTicketChannel(interaction, panel, description) {
  const guild = interaction.guild;
  if (!guild) throw new Error('Tickets can only be opened inside a server.');

  const member = interaction.member;
  const username = (interaction.user.username || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 18) || 'user';

  const scheme = String(panel.settings?.naming_scheme || 'ticket-{username}');
  const baseName = scheme.replaceAll('{username}', username).replaceAll('{id}', String(Date.now()).slice(-6)).replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').slice(0, 90) || `ticket-${username}`;
  const overwrites = [
    {
      id: guild.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        ...(panel.settings?.permission_attachments === 0 ? [] : [PermissionFlagsBits.AttachFiles]),
        ...(panel.settings?.permission_embeds === 0 ? [] : [PermissionFlagsBits.EmbedLinks])
      ]
    }
  ];

  if (client.user) {
    overwrites.push({
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.EmbedLinks
      ]
    });
  }

  const panelSupportRole = String(panel.settings?.support_role_id || supportRoleId || '');
  if (panelSupportRole && /^\d+$/.test(panelSupportRole)) {
    overwrites.push({
      id: panelSupportRole,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
      ]
    });
  }

  const options = {
    name: baseName,
    type: ChannelType.GuildText,
    topic: `Dibiaa ticket | User ID: ${interaction.user.id} | Panel: ${panel.id}`,
    permissionOverwrites: overwrites
  };

  const panelCategoryId = String(panel.settings?.ticket_category_id || ticketCategoryId || '');
  if (panelCategoryId && /^\d+$/.test(panelCategoryId)) options.parent = panelCategoryId;

  const channel = await guild.channels.create(options);
  const embed = new EmbedBuilder()
    .setTitle(String(panel.title || 'Support Ticket').slice(0, 256))
    .setDescription(description.slice(0, 4000))
    .setColor(0xe11d48)
    .addFields(
      { name: 'Opened by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Panel ID', value: String(panel.id), inline: true }
    )
    .setTimestamp();

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('dh_close:' + channel.id)
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Secondary)
  );
  const ticketComponents = (panel.settings?.hide_close_button || panel.settings?.allow_user_close === 0) ? [] : [closeRow];

  await channel.send({
    content: (panel.settings?.mention_support && panel.settings?.support_role_id) ? `<@&${panel.settings.support_role_id}> <@${interaction.user.id}>` : (supportRoleId && !panel.settings ? `<@&${supportRoleId}> <@${interaction.user.id}>` : `<@${interaction.user.id}>`),
    embeds: [embed],
    components: ticketComponents,
    allowedMentions: {
      users: [interaction.user.id],
      roles: (panel.settings?.mention_support && panel.settings?.support_role_id) ? [panel.settings.support_role_id] : (supportRoleId && !panel.settings ? [supportRoleId] : [])
    }
  });

  return channel;
}

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('dh_open:')) {
      const panelId = interaction.customId.slice('dh_open:'.length);
      let panel = panelCache.get(panelId);

      // Recover saved panel settings from the Discord message itself after a Render restart.
      if (!panel) {
        try {
          const message = await interaction.message.fetch();
          const footer = message.embeds?.[0]?.footer?.text || '';
          const match = footer.match(/DH1:([A-Za-z0-9_-]+)/);
          if (match) {
            const recovered = JSON.parse(inflateRawSync(Buffer.from(match[1], 'base64url')).toString('utf8'));
            if (String(recovered.id) === panelId && Array.isArray(recovered.questions)) {
              panel = recovered;
              panelCache.set(panelId, panel);
            }
          }
        } catch (error) {
          console.error('Panel recovery failed:', error.message);
        }
      }

      if (!panel || !Array.isArray(panel.questions) ||
          panel.questions.length < 1 || panel.questions.length > 5) {
        await interaction.reply({
          content: 'This panel is not loaded by the bot. Please ask an admin to publish the panel again.',
          ephemeral: true
        });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId('dh_submit:' + panelId)
        .setTitle(String(panel.title || 'Support Ticket').slice(0, 45));

      panel.questions.forEach((question, index) => {
        const q = String(question || `Question ${index + 1}`);
        const input = new TextInputBuilder()
          .setCustomId('q' + index)
          .setLabel(q.slice(0, 45))
          .setStyle(q.length > 70 ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
      });

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('dh_close:')) {
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: 'Ticket channel not found.', ephemeral: true });
        return;
      }

      const canClose = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
        interaction.user.id === channel.topic?.match(/User ID: (\d+)/)?.[1];

      if (!canClose) {
        await interaction.reply({
          content: 'Only the ticket owner or a moderator can close this ticket.',
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: false });
      try {
        const topicUser = channel.topic?.match(/User ID: (\d+)/)?.[1];
        if (topicUser) {
          await channel.permissionOverwrites.edit(topicUser, {
            SendMessages: false,
            AddReactions: false
          }).catch(() => {});
        }
        const oldName = channel.name.replace(/^closed-/, '');
        const closedName = ('closed-' + oldName).slice(0, 100);
        await channel.setName(closedName, 'Ticket closed; preserving transcript and dashboard record');
        await interaction.editReply('Ticket closed and archived. Transcript channel has been preserved.');
      } catch (error) {
        console.error('Ticket archive failed:', error.message);
        await interaction.editReply('Ticket close nahi ho paya. Bot ki Manage Channels permission check karo.');
      }
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('dh_submit:')) {
      const panelId = interaction.customId.slice('dh_submit:'.length);
      const panel = panelCache.get(panelId);

      if (!panel) {
        await interaction.reply({
          content: 'This panel is no longer loaded. Please ask an admin to publish it again.',
          ephemeral: true
        });
        return;
      }

      const description = panel.questions.map((question, index) => {
        const answer = interaction.fields.getTextInputValue('q' + index);
        return `**${question}**\n${answer}`;
      }).join('\n\n');

      await interaction.deferReply({ ephemeral: true });

      let ticketChannel;
      try {
        ticketChannel = await createPrivateTicketChannel(interaction, panel, description);
      } catch (error) {
        console.error('Ticket channel creation failed:', error.message);
        await interaction.editReply(
          'Ticket channel create nahi ho paya. Bot ko Manage Channels permission aur category/role settings check karvao.'
        );
        return;
      }

      // Best-effort website DB sync. InfinityFree's free-hosting security challenge
      // blocks server-to-server API calls, so Discord ticket creation must not fail
      // just because the website API is unreachable.
      let databaseSaved = false;
      try {
        await saveToWebsite({
          action: 'ticket_create',
          title: String(panel.title || 'Support Ticket'),
          description,
          discord_user_id: interaction.user.id,
          discord_channel_id: ticketChannel.id
        });
        databaseSaved = true;
      } catch (error) {
        console.error('Ticket created in Discord, but website DB sync failed:', error.message);
      }

      const syncMessage = databaseSaved
        ? 'Ticket channel create ho gaya aur website database mein save bhi ho gaya.'
        : 'Ticket channel create ho gaya. Note: InfinityFree security protection ki wajah se website database sync nahi hua; ticket channel Discord mein available hai.';

      await interaction.editReply(`${syncMessage}\nChannel: <#${ticketChannel.id}>`);
      return;
    }
  } catch (error) {
    console.error('Interaction error:', error.message);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Something went wrong. Please try again or contact an admin.',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.once('clientReady', () => {
  console.log(`Dibiaa Hub bot online as ${client.user.tag}`);
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log('Bot API listening on port ' + port);
});

if (!token) {
  console.error('DISCORD_TOKEN is missing');
} else {
  client.login(token).catch(error => {
    console.error('Discord bot login failed:', error.message);
  });
}
