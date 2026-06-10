import dotenv from 'dotenv';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import express from 'express';
import { google } from 'googleapis';

dotenv.config();

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
});

// Umgebungsvariablen — Fallbacks verhindern Crashes bei fehlenden Werten
const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? '';
const DISCORD_TEST_SERVER_ID = process.env.DISCORD_TEST_SERVER_ID ?? '';
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID ?? '';
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? '';
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
const PORT = Number(process.env.PORT) || 3000;

const CHANNEL_ARENA = process.env.CHANNEL_ARENA ?? '';
const CHANNEL_TEAM1_ROT = process.env.CHANNEL_TEAM1_ROT ?? '';
const CHANNEL_TEAM2_BLAU = process.env.CHANNEL_TEAM2_BLAU ?? '';
const CHANNEL_TEAM3_ROT = process.env.CHANNEL_TEAM3_ROT ?? '';
const CHANNEL_TEAM4_BLAU = process.env.CHANNEL_TEAM4_BLAU ?? '';

// Fehlende kritische Variablen loggen (kein Crash)
if (!DISCORD_TOKEN) console.warn('⚠️  DISCORD_TOKEN is not set — Discord bot will not connect');
if (!GOOGLE_PRIVATE_KEY) console.warn('⚠️  GOOGLE_PRIVATE_KEY is not set — Google Sheets integration disabled');

// Discord Bot Ready
client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user?.tag}`);
});

client.on('error', (error) => {
  console.error('❌ Discord client error:', error);
});

app.post('/api/webhook/teams', (req, res) => {
  if (!client.isReady()) {
    console.warn('⚠️ Webhook received but Discord bot is not connected');
    return res.status(503).json({ error: 'Discord bot not connected' });
  }

  const teams = req.body.teams || [];

  console.log(`📨 Received ${teams.length} teams from Google Sheets`);

  postTeamsToDiscord(teams);

  res.json({ success: true });
});

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: client.isReady(),
    config: {
  discordToken: !!DISCORD_TOKEN,
  googlePrivateKey: !!GOOGLE_PRIVATE_KEY,
    },
  });
});

// Teams zu Discord posten
async function postTeamsToDiscord(teams: any[]) {
  try {
    const guild = await client.guilds.fetch(DISCORD_TEST_SERVER_ID);
    console.log(`📍 Guild fetched: ${guild.name}`);

    // Kanäle holen
    const channelArena = await guild.channels.fetch(CHANNEL_ARENA);
    const channelTeam1 = await guild.channels.fetch(CHANNEL_TEAM1_ROT);
    const channelTeam2 = await guild.channels.fetch(CHANNEL_TEAM2_BLAU);
    const channelTeam3 = await guild.channels.fetch(CHANNEL_TEAM3_ROT);
    const channelTeam4 = await guild.channels.fetch(CHANNEL_TEAM4_BLAU);

    const targetChannels = [channelArena, channelTeam1, channelTeam2, channelTeam3, channelTeam4];

    for (const channel of targetChannels) {

      if (!channel || !channel.isTextBased()) {
        continue;
      }

      // Alte Bot-Nachrichten löschen
      try {
        const messages = await channel.messages.fetch({ limit: 100 });

        const botMessages = messages.filter(
          m => m.author.id === client.user?.id
        );

        for (const [, message] of botMessages) {
          await message.delete().catch(() => {});
        }
      } catch (err) {
        console.warn(`⚠️ Konnte alte Nachrichten in ${channel.name} nicht löschen`);
      }

      // Alle Teams in diesen Channel posten
      for (let i = 0; i < teams.length; i++) {

        const team = teams[i];

        let embedColor = 0x808080;

        if (team.color === 'ROT') {
          embedColor = 0xe74c3c;
        }

        if (team.color === 'BLAU') {
          embedColor = 0x3498db;
        }

        let playerList = '';

        team.members.forEach((member: any, index: number) => {

          const classEmoji =
            (member.class || '').match(/^[^\s]+/)?.[0] || '❔';

          let rankEmoji = '⭐';

          if (member.rang) {
            rankEmoji = String(member.rang).trim().split(/\s+/)[0];
          }

          playerList +=
            `__**${member.name}**__ ${rankEmoji} ${member.w}\n` +
            `${classEmoji} ${member.role || '-'}`;

          if (index < team.members.length - 1) {
            playerList += '\n\n';
          }
        });

        const isReserveTeam =
          String(team.name).toUpperCase().startsWith('RESERVE');

        let embedText = playerList;

        if (!isReserveTeam) {
          embedText +=
            '\n\n📊 TEAMWERTE\n' +
            `🛡️ ØT: ${team.avgT ?? '-'}\n` +
            `🏆 WR: ${team.avgWR ?? '-'}\n` +
            `⭐ W: ${team.avgW ?? '-'}`;
        }

        const embed = new EmbedBuilder()
          .setTitle(team.name)
          .setColor(embedColor)
          .addFields([
            {
              name: '\u200B',
              value: embedText,
              inline: false,
            },
          ]);

        await channel.send({
          embeds: [embed]
        });
      }

      console.log(`✅ Gesamte Teamliste in ${channel.name} gepostet`);
    }

    console.log('✅ All teams posted to Discord');

  } catch (error) {
    console.error('❌ Error posting teams:', error);
  }
}

// Express Server starten
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
});

// Discord Bot starten (optional — Server läuft auch ohne erfolgreichen Login)
if (DISCORD_TOKEN) {
  client.login(DISCORD_TOKEN).catch((error) => {
    console.error('❌ Discord login failed:', error);
  });
} else {
  console.warn('⚠️  Skipping Discord login — DISCORD_TOKEN not set');
}
