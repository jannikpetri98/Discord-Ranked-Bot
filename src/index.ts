import dotenv from 'dotenv';
import {Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  GuildMember,
  VoiceChannel,
} from 'discord.js';
import express from 'express';
import { google } from 'googleapis';
import Fuse from 'fuse.js';

dotenv.config();

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildScheduledEvents,
  ],
  partials: [
    Partials.GuildScheduledEvent,
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
const RANKED_EVENT_CHANNEL = process.env.RANKED_EVENT_CHANNEL ?? '';


// Voice-Channel-Mapping: Team-Index (0-basiert) → Voice-Channel-ID
const TEAM_VOICE_CHANNELS: Record<number, string> = {0: CHANNEL_TEAM1_ROT, 1: CHANNEL_TEAM2_BLAU, 2: CHANNEL_TEAM3_ROT, 3: CHANNEL_TEAM4_BLAU,};

// Fehlende kritische Variablen loggen (kein Crash)
if (!DISCORD_TOKEN) console.warn('⚠️  DISCORD_TOKEN is not set — Discord bot will not connect');
if (!GOOGLE_PRIVATE_KEY) console.warn('⚠️  GOOGLE_PRIVATE_KEY is not set — Google Sheets integration disabled');

// ---------------------------------------------------------------------------
// In-Memory Store: zuletzt empfangene Teams für Button-Interactions
// ---------------------------------------------------------------------------
let latestTeams: any[] = [];

const activeEventTimeouts = new Map<
  string,
  NodeJS.Timeout[]
>();

// ---------------------------------------------------------------------------
// Unicode Mathematical Bold → normaler ASCII-Text
//
// Discord-Nutzer schreiben ihre Namen manchmal in Unicode Mathematical Bold
// (z. B. 𝐏𝐥𝐚𝐲𝐞𝐫𝟏). Diese Funktion konvertiert diese Zeichen zurück zu
// normalem ASCII, damit Fuzzy-Matching gegen Sheets-Namen funktioniert.
// ---------------------------------------------------------------------------
function decodeMathBold(input: string): string {
  // Mapping-Tabellen für Mathematical Bold Uppercase/Lowercase/Digits
  const boldUpperStart = 0x1D400; // 𝐀
  const boldLowerStart = 0x1D41A; // 𝐚
  const boldDigitStart = 0x1D7CE; // 𝟎

  let result = '';
  for (const char of input) {
    const cp = char.codePointAt(0) ?? 0;

    if (cp >= boldUpperStart && cp <= boldUpperStart + 25) {
      result += String.fromCharCode(65 + (cp - boldUpperStart)); // A–Z
    } else if (cp >= boldLowerStart && cp <= boldLowerStart + 25) {
      result += String.fromCharCode(97 + (cp - boldLowerStart)); // a–z
    } else if (cp >= boldDigitStart && cp <= boldDigitStart + 9) {
      result += String.fromCharCode(48 + (cp - boldDigitStart)); // 0–9
    } else {
      result += char;
    }
  }
  return result;
}

function isRankedEvent(
  eventName: string
): boolean {

  return decodeMathBold(
    eventName
  )
    .toUpperCase()
    .includes(
      'GILDEN RANKED'
    );
}

// ---------------------------------------------------------------------------
// Fuzzy-Matching: Findet den besten Discord-Member für einen Sheets-Namen
//
// Strategie:
//   1. Exakter Match (nach Normalisierung beider Seiten)
//   2. Fuse.js Fuzzy-Match mit Threshold 0.4
// ---------------------------------------------------------------------------
function findMemberByName(
  members: GuildMember[],
  sheetsName: string,
): GuildMember | null {
  const normalize = (s: string) =>
    decodeMathBold(s).toLowerCase().replace(/\s+/g, '').trim();

  const normalizedTarget = normalize(sheetsName);

  // 1. Exakter Match nach Normalisierung
  const exact = members.find(
    (m) =>
      normalize(m.displayName) === normalizedTarget ||
      normalize(m.user.username) === normalizedTarget,
  );
  if (exact) return exact;

  // 2. Fuse.js Fuzzy-Match
  const fuseData = members.map((m) => ({
    member: m,
    displayName: normalize(m.displayName),
    username: normalize(m.user.username),
  }));

  const fuse = new Fuse(fuseData, {
    keys: ['displayName', 'username'],
    threshold: 0.4,
    includeScore: true,
  });

  const results = fuse.search(normalizedTarget);
  if (results.length > 0) {
    return results[0].item.member;
  }

  return null;
}

function clearEventTimeouts(
  eventId: string
) {

  const handles =
    activeEventTimeouts.get(
      eventId
    );

  if (!handles) {
    return;
  }

  for (const handle of handles) {
    clearTimeout(handle);
  }

  activeEventTimeouts.delete(
    eventId
  );

  console.log(
    `🗑️ Event-Timer gelöscht: ${eventId}`
  );
}

async function sendEventReminder(
  eventId: string,
  type: '6h' | '30m'
) {

  try {

    const guild =
      await client.guilds.fetch(
        DISCORD_TEST_SERVER_ID
      );

    const event =
      await guild.scheduledEvents.fetch(
        eventId
      );

    if (!event) {
      return;
    }

    // Event-Daten neu laden um aktuelle userCount zu bekommen
    const freshEvent =
      await guild.scheduledEvents.fetch({
        guildScheduledEvent: eventId,
        withUserCount: true,
        force: true,
      });

    const reminderChannel =
      guild.channels.cache.get(
        RANKED_EVENT_CHANNEL
      );

    if (
      !reminderChannel ||
      !reminderChannel.isTextBased()
    ) {
      return;
    }

    const interested =
      freshEvent.userCount ?? 0;

    console.log(
      `📊 Event "${event.name}" hat ${interested} interessierte Spieler`
    );

    const eventLink =
      `https://discord.com/events/${guild.id}/${event.id}`;

    if (type === '6h') {

      await reminderChannel.send({
        content: [
`@everyone

⚔️ In 6 Stunden beginnt unser Gilden Ranked!

Heute zählt jeder Sieg, jede Entscheidung und jedes Teamplay.

🏆 Zeigt was ihr könnt und kämpft für die Spitze der Rangliste!`,
          `Event-Link: ${eventLink}`,
        ].join('\n\n')
      });

      console.log(
        `✅ 6h Reminder gesendet: ${event.name}`
      );

      return;
    }

    let message = '';

    if (interested < 10) {

      message =
`@everyone

⚠️ Aktuell haben erst ${interested} Spieler Interesse am heutigen Ranked angemeldet.

Wir benötigen noch weitere Teilnehmer damit das Event stattfinden kann.

🚨 Noch 30 Minuten bis zum Start!

Jeder einzelne Spieler macht den Unterschied!`;
    }

    else {

      message =
`👥 Aktuell haben bereits ${interested} Spieler Interesse am heutigen Ranked angemeldet.

🚨 Noch 30 Minuten bis zum Start!

Die Arena wartet bereits auf euch. Macht euch bereit für spannende Matches und wichtige Ranglistenpunkte!`;
    }

    message +=
      `\n\nEvent-Link: ${eventLink}`;

    await reminderChannel.send({
      content: message
    });

    console.log(
      `✅ 30min Reminder gesendet: ${event.name}`
    );

  } catch (err) {

    console.error(
      '❌ Reminder Fehler',
      err
    );
  }
}

async function scheduleEvent(
  eventId: string
) {

  try {

    const guild =
      await client.guilds.fetch(
        DISCORD_TEST_SERVER_ID
      );

    const event =
      await guild.scheduledEvents.fetch(
        eventId
      );

    if (
      !event ||
      !event.scheduledStartTimestamp
    ) {
      return;
    }

    clearEventTimeouts(eventId);

    const startTime =
      event.scheduledStartTimestamp;

    const now =
      Date.now();

    const timeout6h =
      startTime -
      (6 * 60 * 60 * 1000) -
      now;

    const timeout30m =
      startTime -
      (30 * 60 * 1000) -
      now;

    const handles: NodeJS.Timeout[] = [];

    if (timeout6h > 0) {

      handles.push(
        setTimeout(
          () =>
            void sendEventReminder(
              eventId,
              '6h'
            ),
          timeout6h
        )
      );
    }

    if (timeout30m > 0) {

      handles.push(
        setTimeout(
          () =>
            void sendEventReminder(
              eventId,
              '30m'
            ),
          timeout30m
        )
      );
    }

    activeEventTimeouts.set(
      eventId,
      handles
    );

    console.log(
      `📅 Event geplant: ${event.name}`
    );

  } catch (err) {

    console.error(
      '❌ Event Scheduling Fehler',
      err
    );
  }
}

// ---------------------------------------------------------------------------
// Discord Bot Ready
// ---------------------------------------------------------------------------
client.on('ready', async () => {

  console.log(`✅ Bot logged in as ${client.user?.tag}`);

  try {

    const guild =
      await client.guilds.fetch(
        DISCORD_TEST_SERVER_ID
      );

    await guild.members.fetch();

    console.log(
      `✅ ${guild.members.cache.size} Mitglieder gecached`
    );

    const events =
      await guild.scheduledEvents.fetch();

    console.log(
      `📋 ${events.size} Guild Scheduled Event(s) gefunden`
    );

    for (const [, event] of events) {

      console.log(
        `🔍 Prüfe Event: "${event.name}" (ID: ${event.id})`
      );

      if (
        isRankedEvent(
          event.name
        )
      ) {
        console.log(
          `✅ Ranked Event erkannt beim Start: "${event.name}"`
        );
        await scheduleEvent(
          event.id
        );
      } else {
        console.log(
          `⏭️ Kein Ranked Event, übersprungen: "${event.name}"`
        );
      }
    }

    console.log(
      '✅ Ranked Event Scheduler initialisiert'
    );

  } catch (err) {

    console.error(
      '❌ Fehler beim Initialisieren',
      err
    );
  }
});

// ---------------------------------------------------------------------------
// Discord Event Listener
// ---------------------------------------------------------------------------
client.on(
  'guildScheduledEventCreate',
  async (event) => {

    console.log(
      `📥 guildScheduledEventCreate ausgelöst: "${event.name}" (ID: ${event.id})`
    );

    try {

      if (
        !isRankedEvent(
          event.name
        )
      ) {
        console.log(
          `⏭️ Kein Ranked Event, ignoriert: "${event.name}"`
        );
        return;
      }

      console.log(
        `🆕 Ranked Event erkannt: "${event.name}"`
      );

      await scheduleEvent(
        event.id
      );

    } catch (err) {

      console.error(
        `❌ Fehler in guildScheduledEventCreate (Event: "${event.name}", ID: ${event.id}):`,
        err
      );
    }
  }
);

client.on(
  'guildScheduledEventUpdate',
  async (
    _oldEvent,
    newEvent
  ) => {

    const eventName = newEvent.name ?? '(unbekannt)';

    console.log(
      `📥 guildScheduledEventUpdate ausgelöst: "${eventName}" (ID: ${newEvent.id})`
    );

    try {

      if (
        !newEvent.name ||
        !isRankedEvent(
          newEvent.name
        )
      ) {
        console.log(
          `⏭️ Kein Ranked Event, ignoriert: "${eventName}"`
        );
        return;
      }

      console.log(
        `🔄 Ranked Event aktualisiert: "${eventName}"`
      );

      await scheduleEvent(
        newEvent.id
      );

    } catch (err) {

      console.error(
        `❌ Fehler in guildScheduledEventUpdate (Event: "${eventName}", ID: ${newEvent.id}):`,
        err
      );
    }
  }
);

client.on(
  'guildScheduledEventDelete',
  async (event) => {

    const eventName = event.name ?? '(unbekannt)';

    console.log(
      `📥 guildScheduledEventDelete ausgelöst: "${eventName}" (ID: ${event.id})`
    );

    try {

      clearEventTimeouts(
        event.id
      );

      console.log(
        `🗑️ Ranked Event gelöscht: "${eventName}"`
      );

    } catch (err) {

      console.error(
        `❌ Fehler in guildScheduledEventDelete (Event: "${eventName}", ID: ${event.id}):`,
        err
      );
    }
  }
);
// ---------------------------------------------------------------------------
// Button Interaction Handler: "Alle Teams zuweisen"
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const buttonInteraction = interaction as ButtonInteraction;

  if (buttonInteraction.customId !== 'assign_all_teams') {
    return;
  }

  await buttonInteraction.deferReply({ ephemeral: true });

  try {
    const guild = buttonInteraction.guild;

    if (!guild) {
      throw new Error('Guild nicht verfügbar');
    }

    if (!latestTeams.length) {
      await buttonInteraction.editReply({
        content: '❌ Keine Teamdaten vorhanden. Bitte zuerst Teams erstellen.',
      });
      return;
    }

    const memberList = Array.from(guild.members.cache.values());

    const results: string[] = [];

    for (let teamIndex = 0; teamIndex < latestTeams.length; teamIndex++) {

      const team = latestTeams[teamIndex];

      const voiceChannelId = TEAM_VOICE_CHANNELS[teamIndex];

      if (!voiceChannelId) {
        continue;
      }

      const voiceChannel = guild.channels.cache.get(voiceChannelId);

      if (!voiceChannel || !(voiceChannel instanceof VoiceChannel)) {
        results.push(
          `❌ Voice-Channel für ${team.name} nicht gefunden`
        );
        continue;
      }

      for (const teamMember of team.members as any[]) {

        const sheetsName = teamMember.name ?? '';

        if (!sheetsName) {
          continue;
        }

        const discordMember = findMemberByName(
          memberList,
          sheetsName
        );

        if (!discordMember) {
          results.push(
            `⚠️ Nicht gefunden: ${sheetsName}`
          );
          continue;
        }

        if (!discordMember.voice.channelId) {
          results.push(
            `ℹ️ Nicht im Voice: ${discordMember.displayName}`
          );
          continue;
        }

        try {

          await discordMember.voice.setChannel(
            voiceChannel
          );

          results.push(
            `✅ ${discordMember.displayName} → ${voiceChannel.name}`
          );

        } catch (moveErr) {

          console.error(
            `❌ Fehler beim Verschieben von ${discordMember.displayName}`,
            moveErr
          );

          results.push(
            `❌ Fehler: ${discordMember.displayName}`
          );
        }
      }
    }

    await buttonInteraction.editReply({
      content:
        `🎮 Teamzuweisung abgeschlossen\n\n` +
        results.join('\n'),
    });

  } catch (error) {

    console.error(
      '❌ Fehler beim Zuweisen der Teams:',
      error
    );

    await buttonInteraction.editReply({
      content:
        '❌ Interner Fehler beim Zuweisen. Bitte Logs prüfen.',
    });
  }
});

// ---------------------------------------------------------------------------
// Webhook: Teams empfangen und zu Discord posten
// ---------------------------------------------------------------------------
app.post('/api/webhook/teams', async (req, res) => {
  if (!client.isReady()) {
    console.warn('⚠️ Webhook received but Discord bot is not connected');
    return res.status(503).json({ error: 'Discord bot not connected' });
  }

  const teams = req.body.teams || [];

  console.log(`📨 Received ${teams.length} teams from Google Sheets`);

  // Teams im Speicher halten, damit Button-Interactions darauf zugreifen können
  latestTeams = teams;

  try {

  const guild =
    await client.guilds.fetch(
      DISCORD_TEST_SERVER_ID
    );

  await guild.members.fetch();

  console.log(
    `✅ Member-Cache aktualisiert (${guild.members.cache.size})`
  );

} catch (err) {

  console.error(
    '❌ Fehler beim Aktualisieren des Member-Caches',
    err
  );
}

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

app.post('/api/webhook/reset-arena', async (req, res) => {

  try {

    if (!client.isReady()) {
      return res.status(503).json({
        error: 'Discord bot not connected'
      });
    }

    const guild =
      await client.guilds.fetch(
        DISCORD_TEST_SERVER_ID
      );

    const arenaChannel =
        guild.channels.cache.get(
      CHANNEL_ARENA
    );

    if (
      !arenaChannel ||
      !(arenaChannel instanceof VoiceChannel)
    ) {
      return res.status(400).json({
        error: 'Arena Voice Channel not found'
      });
    }

    const allMembers =
      guild.members.cache;

    let moved = 0;

    for (const [, member] of allMembers) {

      if (!member.voice.channelId) {
        continue;
      }

      const currentChannel =
        member.voice.channelId;

      const isTeamChannel =
        Object.values(
          TEAM_VOICE_CHANNELS
        ).includes(currentChannel);

      if (!isTeamChannel) {
        continue;
      }

      try {

        await member.voice.setChannel(
          arenaChannel
        );

        moved++;

      } catch (err) {

        console.error(
          `Fehler bei ${member.displayName}`,
          err
        );
      }
    }

    console.log(
      `✅ ${moved} Spieler zurück in Arena verschoben`
    );

    res.json({
      success: true,
      moved
    });

  } catch (error) {

    console.error(
      '❌ reset-arena Fehler',
      error
    );

    res.status(500).json({
      error: 'Internal error'
    });
  }
});

// ---------------------------------------------------------------------------
// Teams zu Discord posten (mit "Teams zuweisen!"-Button unter jedem Embed)
// ---------------------------------------------------------------------------
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
          (m) => m.author.id === client.user?.id,
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
        if (team.color === 'ROT') embedColor = 0xe74c3c;
        if (team.color === 'BLAU') embedColor = 0x3498db;

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
        embeds: [embed],
         });
        }
      // Nur im Arena-Channel EINEN globalen Button posten
     if (channel.id === CHANNEL_ARENA) {

     const assignButton = new ButtonBuilder()
    .setCustomId('assign_all_teams')
    .setLabel('🎮 Alle Teams zuweisen')
    .setStyle(ButtonStyle.Success);

    const row =
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(assignButton);

    await channel.send({
    content:
      'Sind alle Spieler bereit? Dann Teamzuweisung starten:',
    components: [row],
    });
      }
    

      console.log(`✅ Gesamte Teamliste in ${channel.name} gepostet`);
    }
  
    console.log('✅ All teams posted to Discord');
  } catch (error) {
    console.error('❌ Error posting teams:', error);
  }
}

// ---------------------------------------------------------------------------
// Express Server starten
// ---------------------------------------------------------------------------
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
