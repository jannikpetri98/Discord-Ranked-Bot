import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
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

// Umgebungsvariablen
const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DISCORD_TEST_SERVER_ID = process.env.DISCORD_TEST_SERVER_ID!;
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID!;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, '\n');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3000');

const CHANNEL_ARENA = process.env.CHANNEL_ARENA!;
const CHANNEL_TEAM1_ROT = process.env.CHANNEL_TEAM1_ROT!;
const CHANNEL_TEAM2_BLAU = process.env.CHANNEL_TEAM2_BLAU!;
const CHANNEL_TEAM3_ROT = process.env.CHANNEL_TEAM3_ROT!;
const CHANNEL_TEAM4_BLAU = process.env.CHANNEL_TEAM4_BLAU!;

// Google Sheets Auth
const sheets = google.sheets({
  version: 'v4',
  auth: new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  }),
});

// Discord Bot Ready
client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user?.tag}`);
});

// Webhook Endpoint
app.post('/api/webhook/teams', (req, res) => {
  // Webhook Secret validieren
  const signature = req.headers['x-webhook-signature'] as string;
  const body = JSON.stringify(req.body);
  const hash = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

  if (signature !== hash) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const teams = req.body.teams;
  postTeamsToDiscord(teams);
  res.json({ success: true });
});

// Teams zu Discord posten
async function postTeamsToDiscord(teams: any[]) {
  const guild = await client.guilds.fetch(DISCORD_TEST_SERVER_ID);

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

    if (!channel || !channel.isTextBased()) continue;

    const embed = {
      title: `Team ${i + 1}`,
      color: team.color === 'ROT' ? 0xff0000 : 0x0000ff,
      fields: team.members.map((member: any) => ({
        name: member.name,
        value: `${member.class} - ${member.role}`,
        inline: true,
      })),
    };

    await (channel as any).send({ embeds: [embed] });
  }

  console.log('✅ Teams posted to Discord');
}

// Bot starten
client.login(DISCORD_TOKEN);

// Express Server starten
app.listen(WEBHOOK_PORT, () => {
  console.log(`🚀 Webhook server running on port ${WEBHOOK_PORT}`);
});
