
require('dotenv').config();

const express = require('express');
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
  TextInputStyle
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

function authorized(req) {
  return Boolean(
    apiKey &&
    req.get('X-API-Key') &&
    req.get('X-API-Key') === apiKey
  );
}

async function saveToWebsite(data) {
  if (!websiteApi) {
    throw new Error('WEBSITE_API_URL missing');
  }

  const r = await fetch(websiteApi, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey || ''
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000)
  });

  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.ok) {
    throw new Error(j.error || 'Website API request failed');
  }

  return j;
}

// Health check
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Dibiaa Hub Discord Bot',
    botReady: client.isReady()
  });
});

// Discord OAuth: exchange authorization code on Render.
// PHP must validate the OAuth state in its session BEFORE calling this.
app.post('/oauth/discord/exchange', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  if (!discordClientId || !discordClientSecret) {
    return res.status(500).json({
      ok: false,
      error: 'Discord OAuth environment variables are missing'
    });
  }

  const code = typeof req.body?.code === 'string'
    ? req.body.code.trim()
    : '';

  const redirectUri = typeof req.body?.redirect_uri === 'string'
    ? req.body.redirect_uri.trim()
    : '';

  if (!code || code.length > 2048) {
    return res.status(400).json({
      ok: false,
      error: 'Missing or invalid authorization code'
    });
  }

  // Only allow the exact redirect URI registered for this app.
  if (redirectUri !== discordRedirectUri) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid redirect URI'
    });
  }

  try {
    const form = new URLSearchParams({
      client_id: discordClientId,
      client_secret: discordClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: discordRedirectUri
    });

    const tokenResponse = await fetch(
      'https://discord.com/api/oauth2/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form,
        signal: AbortSignal.timeout(15000)
      }
    );

    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !tokenData.access_token) {
      // Do not log the code, token, or client secret.
      console.error(
        'Discord OAuth token exchange failed. HTTP:',
        tokenResponse.status
      );

      return res.status(502).json({
        ok: false,
        error: 'Discord authorization failed. Please try logging in again.'
      });
    }

    const headers = {
      Authorization: `Bearer ${tokenData.access_token}`
    };

    const [userResponse, guildResponse] = await Promise.all([
      fetch('https://discord.com/api/v10/users/@me', {
        headers,
        signal: AbortSignal.timeout(15000)
      }),
      fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers,
        signal: AbortSignal.timeout(15000)
      })
    ]);

    const user = await userResponse.json().catch(() => ({}));
    const guilds = await guildResponse.json().catch(() => []);

    if (!userResponse.ok || !user.id || !guildResponse.ok ||
        !Array.isArray(guilds)) {
      return res.status(502).json({
        ok: false,
        error: 'Could not load Discord profile or servers'
      });
    }

    // Return only servers where the user is owner,
    // has Manage Server, or has Administrator permission.
    const manageableGuilds = guilds.filter(guild => {
      try {
        const permissions = BigInt(guild.permissions || '0');

        const isOwner = guild.owner === true;
        const canManageGuild = (permissions & 0x20n) !== 0n;
        const isAdministrator = (permissions & 0x8n) !== 0n;

        return isOwner || canManageGuild || isAdministrator;
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

    // Never return access/refresh tokens to the PHP website.
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

// Publish ticket panel
app.post('/publish-panel', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  try {
    const {
      panel_id,
      guild_id,
      channel_id,
      title,
      description,
      questions
    } = req.body || {};

    if (
      !panel_id ||
      !guild_id ||
      !channel_id ||
      !title ||
      !Array.isArray(questions) ||
      questions.length < 1 ||
      questions.length > 5
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Missing fields or invalid questions (1-5).'
      });
    }

    const guild = await client.guilds.fetch(String(guild_id));
    const channel = await guild.channels.fetch(String(channel_id));

    if (!channel || !channel.isTextBased() || !channel.send) {
      return res.status(400).json({
        ok: false,
        error: 'Channel not found or not a text channel.'
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(String(title).slice(0, 256))
      .setDescription(
        String(description || 'Click below to open a ticket.').slice(0, 4000)
      )
      .setColor(0xe11d48)
      .setFooter({ text: 'Dibiaa Hub • Ticket Panel' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('dh_open:' + String(panel_id))
        .setLabel('Create Ticket')
        .setStyle(ButtonStyle.Danger)
    );

    const msg = await channel.send({
      embeds: [embed],
      components: [row]
    });

    await saveToWebsite({
      action: 'panel_published',
      panel_id,
      message_id: msg.id
    });

    return res.json({
      ok: true,
      message_id: msg.id,
      channel_id: channel.id
    });
  } catch (e) {
    console.error('Panel publish error:', e.message);

    return res.status(500).json({
      ok: false,
      error: e.message || 'Panel publish failed'
    });
  }
});

// Ticket interactions
client.on('interactionCreate', async i => {
  try {
    if (i.isButton() && i.customId.startsWith('dh_open:')) {
      const data = await saveToWebsite({
        action: 'panel_get',
        panel_id: Number(i.customId.slice(8))
      });

      const p = {
        t: data.panel.title,
        q: data.panel.questions
      };

      const modal = new ModalBuilder()
        .setCustomId(
          'dh_submit:' + Buffer.from(JSON.stringify(p)).toString('base64url')
        )
        .setTitle(String(p.t || 'Support Ticket').slice(0, 45));

      for (let n = 0; n < p.q.length && n < 5; n++) {
        const input = new TextInputBuilder()
          .setCustomId('q' + n)
          .setLabel(String(p.q[n]).slice(0, 45))
          .setStyle(
            n === p.q.length - 1 && String(p.q[n]).length > 70
              ? TextInputStyle.Paragraph
              : TextInputStyle.Short
          )
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(
          new ActionRowBuilder().addComponents(input)
        );
      }

      await i.showModal(modal);
      return;
    }

    if (i.isModalSubmit() && i.customId.startsWith('dh_submit:')) {
      const p = JSON.parse(
        Buffer.from(i.customId.slice(10), 'base64url').toString()
      );

      const desc = p.q.map((q, n) =>
        '**' + q + '**\n' + i.fields.getTextInputValue('q' + n)
      ).join('\n\n');

      await i.reply({
        content: 'Ticket request received. Saving to Dibiaa Hub…',
        ephemeral: true
      });

      let saved;

      try {
        saved = await saveToWebsite({
          action: 'ticket_create',
          title: p.t,
          description: desc,
          discord_user_id: i.user.id,
          discord_channel_id: i.channelId
        });
      } catch (e) {
        console.error('DB save failed:', e.message);

        await i.followUp({
          content: 'Ticket form was received but website database save failed. Please contact an admin.',
          ephemeral: true
        });
        return;
      }

      await i.followUp({
        content: 'Ticket saved: **' + saved.ticket_code +
          '**. Staff will follow up in this server.',
        ephemeral: true
      });
      return;
    }
  } catch (e) {
    console.error('Interaction error:', e.message);

    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i.reply({
        content: 'Something went wrong. Please try again or contact an admin.',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.once('ready', () => {
  console.log(`Dibiaa Hub bot online as ${client.user.tag}`);
});

app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log('Bot API listening on port ' + (process.env.PORT || 3000));
});

if (!token) {
  console.error('DISCORD_TOKEN is missing');
} else {
  client.login(token);
}
