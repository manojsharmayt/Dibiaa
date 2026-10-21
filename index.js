
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

// Verify requests from the website.
function authorized(req) {
  return Boolean(
    apiKey &&
    req.get('X-API-Key') &&
    req.get('X-API-Key') === apiKey
  );
}

// Send data to the website API.
async function saveToWebsite(data) {
  if (!websiteApi) {
    throw new Error('WEBSITE_API_URL missing');
  }

  if (!apiKey) {
    throw new Error('API_KEY missing');
  }

  const response = await fetch(websiteApi, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.text();
  let result = {};

  try {
    result = JSON.parse(body);
  } catch {
    // The website response was not JSON.
  }

  if (!response.ok || !result.ok) {
    console.error('Website API status:', response.status);
    console.error('Website API response:', body.slice(0, 1000));

    throw new Error(
      `Website API failed (HTTP ${response.status}): ${
        result.error || body.slice(0, 200) || 'Empty response'
      }`
    );
  }

  return result;
}

// Health check.
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Dibiaa Hub Discord Bot',
    botReady: client.isReady()
  });
});

// Discord OAuth code exchange.
// The PHP callback must validate OAuth state before calling this endpoint.
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

  const code =
    typeof req.body?.code === 'string'
      ? req.body.code.trim()
      : '';

  const redirectUri =
    typeof req.body?.redirect_uri === 'string'
      ? req.body.redirect_uri.trim()
      : '';

  if (!code || code.length > 2048) {
    return res.status(400).json({
      ok: false,
      error: 'Missing or invalid authorization code'
    });
  }

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
      console.error(
        'Discord OAuth token exchange failed. HTTP:',
        tokenResponse.status
      );

      return res.status(502).json({
        ok: false,
        error: 'Discord authorization failed. Please log in again.'
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

    if (
      !userResponse.ok ||
      !user.id ||
      !guildResponse.ok ||
      !Array.isArray(guilds)
    ) {
      return res.status(502).json({
        ok: false,
        error: 'Could not load Discord profile or servers'
      });
    }

    // Keep servers owned by the user or where they have
    // Manage Server or Administrator permissions.
    const manageableGuilds = guilds
      .filter(guild => {
        try {
          const permissions = BigInt(guild.permissions || '0');

          const isOwner = guild.owner === true;
          const canManageGuild = (permissions & 0x20n) !== 0n;
          const isAdministrator = (permissions & 0x8n) !== 0n;

          return isOwner || canManageGuild || isAdministrator;
        } catch {
          return false;
        }
      })
      .map(guild => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon || null,
        owner: guild.owner === true,
        permissions: guild.permissions
      }));

    // Never send Discord access tokens to the website.
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

// Publish a ticket panel to a Discord channel.
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

    if (!client.isReady()) {
      return res.status(503).json({
        ok: false,
        error: 'Discord bot is not ready yet.'
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
        String(
          description || 'Click below to open a ticket.'
        ).slice(0, 4000)
      )
      .setColor(0xe11d48)
      .setFooter({
        text: 'Dibiaa Hub • Ticket Panel'
      });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('dh_open:' + String(panel_id))
        .setLabel('Create Ticket')
        .setStyle(ButtonStyle.Danger)
    );

    const message = await channel.send({
      embeds: [embed],
      components: [row]
    });

    // Record the published message in the website database.
    await saveToWebsite({
      action: 'panel_published',
      panel_id,
      message_id: message.id
    });

    return res.json({
      ok: true,
      message_id: message.id,
      channel_id: channel.id
    });
  } catch (error) {
    console.error('Panel publish error:', error.message);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Panel publish failed'
    });
  }
});

// Handle ticket buttons and submitted forms.
client.on('interactionCreate', async interaction => {
  try {
    // User clicked Create Ticket.
    if (
      interaction.isButton() &&
      interaction.customId.startsWith('dh_open:')
    ) {
      const panelId = Number(interaction.customId.slice(8));

      const data = await saveToWebsite({
        action: 'panel_get',
        panel_id: panelId
      });

      if (
        !data.panel ||
        !Array.isArray(data.panel.questions) ||
        data.panel.questions.length < 1
      ) {
        await interaction.reply({
          content: 'This ticket panel is not configured correctly.',
          ephemeral: true
        });
        return;
      }

      const panel = {
        t: String(data.panel.title || 'Support Ticket'),
        q: data.panel.questions.map(question => String(question))
      };

      if (panel.q.length > 5) {
        await interaction.reply({
          content: 'This ticket panel has too many questions.',
          ephemeral: true
        });
        return;
      }

      const modalPayload = Buffer
        .from(JSON.stringify(panel))
        .toString('base64url');

      const modal = new ModalBuilder()
        .setCustomId('dh_submit:' + modalPayload)
        .setTitle(panel.t.slice(0, 45));

      for (let n = 0; n < panel.q.length; n++) {
        const question = panel.q[n];

        const input = new TextInputBuilder()
          .setCustomId('q' + n)
          .setLabel(question.slice(0, 45))
          .setStyle(
            n === panel.q.length - 1 && question.length > 70
              ? TextInputStyle.Paragraph
              : TextInputStyle.Short
          )
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(
          new ActionRowBuilder().addComponents(input)
        );
      }

      await interaction.showModal(modal);
      return;
    }

    // User submitted the ticket form.
    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith('dh_submit:')
    ) {
      let panel;

      try {
        const encoded = interaction.customId.slice(10);
        panel = JSON.parse(
          Buffer.from(encoded, 'base64url').toString('utf8')
        );
      } catch {
        await interaction.reply({
          content: 'Invalid ticket form. Please open the ticket panel again.',
          ephemeral: true
        });
        return;
      }

      if (!Array.isArray(panel.q) || panel.q.length < 1 || panel.q.length > 5) {
        await interaction.reply({
          content: 'Invalid ticket questions. Please contact an admin.',
          ephemeral: true
        });
        return;
      }

      const description = panel.q
        .map((question, index) => {
          const answer = interaction.fields.getTextInputValue('q' + index);
          return '**' + question + '**\n' + answer;
        })
        .join('\n\n');

      await interaction.reply({
        content: 'Ticket request received. Saving to Dibiaa Hub…',
        ephemeral: true
      });

      let saved;

      try {
        saved = await saveToWebsite({
          action: 'ticket_create',
          title: String(panel.t || 'Support Ticket'),
          description,
          discord_user_id: interaction.user.id,
          discord_channel_id: interaction.channelId
        });
      } catch (error) {
        console.error('Ticket database save failed:', error.message);

        await interaction.followUp({
          content: 'The form was received, but saving failed. Please contact an admin.',
          ephemeral: true
        });
        return;
      }

      await interaction.followUp({
        content: 'Ticket saved: **' +
          String(saved.ticket_code || 'Created') +
          '**. Staff will follow up in this server.',
        ephemeral: true
      });
    }
  } catch (error) {
    console.error('Interaction error:', error.message);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content: 'Something went wrong. Please try again or contact an admin.',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

// Discord bot ready event.
client.once('clientReady', () => {
  console.log(`Dibiaa Hub bot online as ${client.user.tag}`);
});

// Start the Render web service.
const port = Number(process.env.PORT || 3000);

app.listen(port, '0.0.0.0', () => {
  console.log('Bot API listening on port ' + port);
});

// Log in to Discord.
if (!token) {
  console.error('DISCORD_TOKEN is missing');
} else {
  client.login(token).catch(error => {
    console.error('Discord bot login failed:', error.message);
  });
}
