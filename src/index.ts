import dotenv from 'dotenv';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import express from 'express';
import { google } from 'googleapis';
import crypto from 'crypto';

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
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
const PORT = Number(process.env.PORT) || 3000;

const CHANNEL_ARENA = process.env.CHANNEL_ARENA ?? '';
const CHANNEL_TEAM1_ROT = process.env.CHANNEL_TEAM1_ROT ?? '';
const CHANNEL_TEAM2_BLAU = process.env.CHANNEL_TEAM2_BLAU ?? '';
const CHANNEL_TEAM3_ROT = process.env.CHANNEL_TEAM3_ROT ?? '';
const CHANNEL_TEAM4_BLAU = process.env.CHANNEL_TEAM4_BLAU ?? '';

// Fehlende kritische Variablen loggen (kein Crash)
if (!DISCORD_TOKEN) console.warn('⚠️  DISCORD_TOKEN is not set — Discord bot will not connect');
if (!GOOGLE_PRIVATE_KEY) console.warn('⚠️  GOOGLE_PRIVATE_KEY is not set — Google Sheets integration disabled');
if (!WEBHOOK_SECRET) console.warn('⚠️  WEBHOOK_SECRET is not set — webhook signature validation will reject all requests');

// Discord Bot Ready
client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user?.tag}`);
});

client.on('error', (error) => {
  console.error('❌ Discord client error:', error);
});

// Webhook Endpoint
app.post('/api/webhook/teams', (req, res) => {
  // Webhook Secret validieren
  if (!WEBHOOK_SECRET) {
    console.error('❌ WEBHOOK_SECRET is not configured');
    return res.status(503).json({ error: 'Webhook secret not configured' });
  }

  const signature = req.headers['x-webhook-signature'] as string;
  const body = JSON.stringify(req.body);
  const hash = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  // DEBUG
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Received Signature :', signature);
  console.log('Calculated Signature:', hash);
  console.log('Body:', body);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (signature !== hash) {
    console.warn('❌ Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (!client.isReady()) {
    console.warn('⚠️  Webhook received but Discord bot is not connected');
    return res.status(503).json({ error: 'Discord bot not connected' });
  }

  const teams = req.body.teams;
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
      webhookSecret: !!WEBHOOK_SECRET,
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

    const channels = [channelTeam1, channelTeam2, channelTeam3, channelTeam4];

    // Teams posten
    for (let i = 0; i < teams.length; i++) {
      const team = teams[i];
      const channel = channels[i];

      if (!channel || !channel.isTextBased()) {
        console.warn(`⚠️ Channel ${i + 1} not found or not text-based`);
        continue;
      }

      const embed = new EmbedBuilder()
        .setTitle(`Team ${i + 1}`)
        .setColor(team.color === 'ROT' ? 0xff0000 : 0x0000ff)
        .addFields(
          team.members.map((member: any) => ({
            name: member.name,
            value: `${member.class} - ${member.role}`,
            inline: true,
          }))
        );

      await (channel as any).send({ embeds: [embed] });
      console.log(`✅ Team ${i + 1} posted to ${(channel as any).name}`);
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
