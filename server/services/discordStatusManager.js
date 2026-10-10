import path from 'path';
import { serverConfig, isConfiguredSecret } from '../config.js';
import { atomicWriteJson, readJsonWithBackup } from '../../src/shared/atomicStore.js';
import { log, safeErrorMessage } from '../../src/shared/structuredLogger.js';
import { DiscordClient } from './discordClient.js';

export const SYSTEM_STATUS = Object.freeze({ UP: 'UP', REUPLOADING: 'REUPLOADING', DOWN: 'DOWN' });

const DEFAULTS = Object.freeze({
  report: '1557731440676966420',
  statusVoice: '1226004017394614325',
  gameLinkEmbed: '1226004017633820772',
  players: '1275393110213656667',
  favorites: '1275393071089192960',
  visits: '1275393127993311253',
  bugChannel: '1231058747644973096',
  updatesChannel: '1226004017633820776',
  codesChannel: '1226004018011181083',
  boosterCodesChannel: '1430940814376435773',
  groupUrl: 'https://www.roblox.com/communities/12396638/John-admin#!/about',
  botIcon: 'https://discordapp.com/assets/73763de9b2924904.svg',
});

const statePath = () => path.join(serverConfig.dataDir, 'discord-state.json');
let state = null;

function loadState() {
  if (state) return state;
  try {
    state = readJsonWithBackup(statePath(), {
      fallback: {
        statusMessageId: null,
        gameLinkEmbedMessageId: null,
        voiceState: {},
        lastStats: {},
        lastStatus: null,
        lastAnnouncedStatus: null,
        lastGameLink: '',
      }
    });
  } catch {
    state = {
      statusMessageId: null,
      gameLinkEmbedMessageId: null,
      voiceState: {},
      lastStats: {},
      lastStatus: null,
      lastAnnouncedStatus: null,
      lastGameLink: '',
    };
  }
  return state;
}

function saveState() {
  atomicWriteJson(statePath(), state, { backup: true });
}

function channelIds(config) {
  const monitor = config?.monitor || {};
  return {
    // These two are the fixed channels requested for the production status UI.
    // Environment variables may override them, but an old /data/config.json value
    // must not silently redirect status traffic to a stale channel ID.
    report: String(process.env.DISCORD_STATUS_REPORT_CHANNEL_ID || DEFAULTS.report).trim(),
    statusVoice: String(process.env.DISCORD_STATUS_VOICE_CHANNEL_ID || DEFAULTS.statusVoice).trim(),
    gameLinkEmbed: String(process.env.DISCORD_GAME_LINK_EMBED_CHANNEL_ID || DEFAULTS.gameLinkEmbed).trim(),
    favorites: String(process.env.DISCORD_FAVORITES_CHANNEL_ID || monitor.discordFavoritesChannelId || DEFAULTS.favorites).trim(),
    visits: String(process.env.DISCORD_VISITS_CHANNEL_ID || monitor.discordVisitsChannelId || DEFAULTS.visits).trim(),
    players: String(process.env.DISCORD_PLAYERS_CHANNEL_ID || monitor.discordPlayerCountChannelId || DEFAULTS.players).trim(),
  };
}

function announcementSettings(config) {
  const monitor = config?.monitor || {};
  return {
    bugChannel: String(monitor.discordBugChannelId || DEFAULTS.bugChannel).trim(),
    updatesChannel: String(monitor.discordUpdatesChannelId || DEFAULTS.updatesChannel).trim(),
    codesChannel: String(monitor.discordCodesChannelId || DEFAULTS.codesChannel).trim(),
    boosterCodesChannel: String(monitor.discordBoosterCodesChannelId || DEFAULTS.boosterCodesChannel).trim(),
    groupUrl: String(monitor.discordGroupUrl || DEFAULTS.groupUrl).trim(),
    botIcon: String(monitor.discordBotIconUrl || DEFAULTS.botIcon).trim(),
    announceHere: monitor.discordAnnounceHere !== false,
  };
}

function statusText(status, details = {}) {
  const emoji = status === SYSTEM_STATUS.UP ? '🟢' : status === SYSTEM_STATUS.REUPLOADING ? '🟡' : '🔴';
  const game = details.gameLink || details.gameUrl || 'Unknown game';
  const operation = details.operation ? `\nOperation: ${details.operation}` : '';
  const reason = details.reason ? `\nReason: ${details.reason}` : '';
  const target = details.target ? `\nTarget: ${details.target}` : '';
  const time = new Date().toISOString();
  if (status === SYSTEM_STATUS.UP) return `${emoji} **UP**\nGame: ${game}\nStatus: Online${target}${time ? `\nUpdated: ${time}` : ''}`;
  if (status === SYSTEM_STATUS.REUPLOADING) return `${emoji} **REUPLOADING**\nGame: ${game}\nStatus: Reuploading${operation}${target}\nUpdated: ${time}`;
  return `${emoji} **DOWN**\nGame: ${game}\nStatus: Failed${reason}${operation}\nUpdated: ${time}`;
}

function statusEmbed(status, details = {}, config = {}) {
  const settings = announcementSettings(config);
  const gameLink = details.gameLink || details.gameUrl || state?.lastGameLink || '';
  const isUp = status === SYSTEM_STATUS.UP;
  const isReuploading = status === SYSTEM_STATUS.REUPLOADING;
  const statusEmoji = isUp ? '🟢' : isReuploading ? '🟡' : '🔴';
  const statusLabel = isUp ? 'UP' : isReuploading ? 'REUPLOADING' : 'DOWN';
  const color = isUp ? 0x57F287 : isReuploading ? 0xFEE75C : 0xED4245;

  return {
    color,
    title: 'GAME LINK',
    url: gameLink || undefined,
    author: {
      name: '🛠️ Tuna Bot - Uploader',
      icon_url: settings.botIcon,
    },
    description: [
      `**Game Status:** ${statusEmoji} ${statusLabel}`,
      '',
      `**Play Here:** ${gameLink ? `[game link](${gameLink})` : 'game link unavailable'}`,
    ].join('\n'),
    footer: { text: 'Powered by TNB' },
    timestamp: new Date().toISOString(),
  };
}

function buildUpAnnouncement(config, details = {}) {
  const settings = announcementSettings(config);
  const gameLink = details.gameLink || details.gameUrl || state?.lastGameLink || '';
  return [
    settings.announceHere ? '@here' : '',
    '**The game is back with your data completely restored!**',
    `You can find the game in <#${DEFAULTS.gameLinkEmbed}>${gameLink ? `\n**Game Link:** ${gameLink}` : ''}`,
    `If you find any bugs, make sure to report them in <#${settings.bugChannel}> so we can fix them!`,
    '',
    'This is a full upload with Animations, Dev Products, and Music.',
    `The latest updates can be found in <#${settings.updatesChannel}> with all the details you need there!`,
    `You can find all the most recent codes in <#${settings.codesChannel}> and Booster Codes in: <#${settings.boosterCodesChannel}>`,
    '',
    '## 🎯 Current Goals:',
    '- **150 Likes** = New Code',
    '- **1500 Favorites** = New Code',
    '- **200 Active Players** = New Code',
    '',
    '## 📣 How You Can Help:',
    '✅ **Like the game**',
    '⭐ **Favorite the game**',
    '📨 **Invite your friends to join the adventure!**',
    ':thumbsup: **Boost the server for booster codes, booster only game link**',
    '',
    '# Game Link:',
    `# 👉 ${gameLink || 'Unavailable'}`,
    '# Group Link:',
    `# 👉 ${settings.groupUrl}`,
    '💰 | How do I get gamepasses?',
    'Simply join our community group above to unlock them instantly.',
    '🔥 | DATA:',
    'Your data is kept safe by us! We keep it stored safely so you can continue playing with it next reupload.',
    '❤️ | MONSTER:',
    'For a Monster, join the official Community Group, and then head over to the far right house in Silvent City and talk to the man inside.',
    '💳 | CODES:',
    'For all codes in Monster Brick Bronze, join our Community Group above.',
  ].filter((line, index, arr) => !(line === '' && index === 0) && !(line === '' && index === arr.length - 1)).join('\n');
}

function buildDownAnnouncement(config, details = {}) {
  const settings = announcementSettings(config);
  const reason = details.reason ? `\nReason: ${details.reason}` : '';
  return [
    settings.announceHere ? '@here' : '',
    '**The game is currently down.**',
    'The uploader detected that the live experience is unavailable and is working to restore it.',
    `Status: 🔴 DOWN${reason}`,
    `Updates will be reflected in <#${settings.updatesChannel}>.`,
  ].filter(Boolean).join('\n');
}

async function upsertPersistentEmbed(client, channelId, persisted, status, details, config) {
  const payload = { embeds: [statusEmbed(status, details, config)] };
  let messageId = String(persisted.gameLinkEmbedMessageId || '').trim();

  if (messageId) {
    try {
      await client.editMessagePayload(channelId, messageId, payload);
      return messageId;
    } catch (error) {
      if (![403, 404].includes(error?.status)) throw error;
      messageId = '';
      persisted.gameLinkEmbedMessageId = null;
      saveState();
    }
  }

  try {
    const messages = await client.listMessages(channelId);
    const existing = Array.isArray(messages)
      ? messages.find((message) => {
          if (!message?.author?.bot) return false;
          return (message.embeds || []).some((embed) => String(embed?.title || '').trim().toUpperCase() === 'GAME LINK');
        })
      : null;

    if (existing?.id) {
      messageId = String(existing.id);
      await client.editMessagePayload(channelId, messageId, payload);
      persisted.gameLinkEmbedMessageId = messageId;
      saveState();
      return messageId;
    }
  } catch (error) {
    if (error?.status === 404) throw error;
    log('WARN', 'Discord game-link embed lookup failed', { error: safeErrorMessage(error), channelId });
  }

  const sent = await client.sendMessagePayload(channelId, payload);
  messageId = String(sent?.id || '');
  persisted.gameLinkEmbedMessageId = messageId || null;
  saveState();
  return messageId;
}

async function announceStatusTransition(client, channelId, persisted, status, details, config) {
  if (status === SYSTEM_STATUS.REUPLOADING) return;
  const previous = persisted.lastStatusBeforeAnnouncement || persisted.lastStatus;
  const shouldAnnounce = Boolean(details.forceAnnouncement) ||
    (status === SYSTEM_STATUS.UP && previous !== SYSTEM_STATUS.UP) ||
    (status === SYSTEM_STATUS.DOWN && previous !== SYSTEM_STATUS.DOWN);

  if (!shouldAnnounce) return;

  const content = status === SYSTEM_STATUS.UP
    ? buildUpAnnouncement(config, details)
    : buildDownAnnouncement(config, details);

  await client.sendMessagePayload(channelId, {
    content,
    allowed_mentions: { parse: announcementSettings(config).announceHere ? ['everyone'] : [] },
  });

  persisted.lastAnnouncedStatus = status;
  saveState();
}

export async function setSystemStatus(status, details = {}, config = {}) {
  if (!Object.values(SYSTEM_STATUS).includes(status)) throw new Error(`Invalid system status: ${status}`);

  const current = loadState();
  const ids = channelIds(config);
  const token = String(config?.monitor?.discordBotToken || process.env.DISCORD_BOT_TOKEN || '').trim();
  const previousStatus = current.lastStatus;
  const gameLink = String(details.gameLink || details.gameUrl || current.lastGameLink || '').trim();
  const statusChanged = previousStatus !== status;
  const linkChanged = gameLink !== String(current.lastGameLink || '');

  current.lastStatusBeforeAnnouncement = previousStatus;
  current.lastStatus = status;
  current.lastStatusAt = new Date().toISOString();
  if (gameLink) current.lastGameLink = gameLink;
  saveState();

  if (!isConfiguredSecret(token)) {
    return { skipped: true, status, reason: 'Discord bot token not configured' };
  }

  const client = new DiscordClient(token);
  const enriched = { ...details, gameLink: gameLink || details.gameLink || details.gameUrl || '' };
  let statusMessageId = current.statusMessageId;
  let embedMessageId = current.gameLinkEmbedMessageId;
  const results = { status, messageId: statusMessageId, embedMessageId };

  // Report channel: persistent status message.
  try {
    const content = statusText(status, enriched);
    if (statusMessageId) {
      try {
        await client.editMessage(ids.report, statusMessageId, content);
      } catch (error) {
        if (![403, 404].includes(error?.status)) throw error;
        statusMessageId = null;
        current.statusMessageId = null;
      }
    }

    if (!statusMessageId) {
      const sent = await client.sendMessage(ids.report, content);
      statusMessageId = String(sent?.id || '');
      current.statusMessageId = statusMessageId || null;
      saveState();
    }
    results.messageId = statusMessageId;
  } catch (error) {
    log('WARN', 'Discord report status update failed', {
      status,
      channelId: ids.report,
      error: safeErrorMessage(error),
    });
  }

  // GAME LINK embed: independent from the report channel so one broken channel
  // cannot prevent the embed from appearing/editing.
  if (statusChanged || linkChanged || details.force) {
    try {
      embedMessageId = await upsertPersistentEmbed(client, ids.gameLinkEmbed, current, status, enriched, config);
      results.embedMessageId = embedMessageId;
    } catch (error) {
      log('WARN', 'Discord GAME LINK embed update failed', {
        status,
        channelId: ids.gameLinkEmbed,
        error: safeErrorMessage(error),
      });
    }
  }

  // @here transition announcement in the report channel.
  if (statusChanged || details.forceAnnouncement) {
    try {
      await announceStatusTransition(client, ids.report, current, status, enriched, config);
    } catch (error) {
      log('WARN', 'Discord status announcement failed', {
        status,
        channelId: ids.report,
        error: safeErrorMessage(error),
      });
    }
  }

  // Voice channel is independently best-effort.
  try {
    await setStatusVoiceChannel(client, ids.statusVoice, status, current);
  } catch (error) {
    log('WARN', 'Discord status voice-channel update failed', {
      status,
      channelId: ids.statusVoice,
      error: safeErrorMessage(error),
    });
  }

  current.lastStatus = status;
  current.lastStatusAt = new Date().toISOString();
  current.statusMessageId = statusMessageId || current.statusMessageId || null;
  current.gameLinkEmbedMessageId = embedMessageId || current.gameLinkEmbedMessageId || null;
  saveState();

  return results;
}

async function setStatusVoiceChannel(client, channelId, status, persisted) {
  if (!channelId) return;
  const target = status === SYSTEM_STATUS.UP ? '🟢・UP' : status === SYSTEM_STATUS.REUPLOADING ? '🟡・REUPLOADING' : '🔴・DOWN';
  const previous = persisted.voiceState?.status;
  if (previous === target) return;
  try {
    const channel = await client.getChannel(channelId);
    if (channel?.name !== target) await client.renameChannel(channelId, target);
    persisted.voiceState = { ...(persisted.voiceState || {}), status: target };
    saveState();
  } catch (error) {
    log('WARN', 'Discord status voice-channel update failed', { error: safeErrorMessage(error), channelId });
  }
}

export async function updateStatisticChannel(config, statKey, value) {
  const token = String(config?.monitor?.discordBotToken || process.env.DISCORD_BOT_TOKEN || '').trim();
  if (!isConfiguredSecret(token)) return;
  const ids = channelIds(config);
  const channelId = statKey === 'favorites' ? ids.favorites : statKey === 'visits' ? ids.visits : ids.players;
  const emoji = statKey === 'favorites' ? '⭐' : statKey === 'visits' ? '👁️' : '👥';
  const label = statKey === 'favorites' ? 'Favorites' : statKey === 'visits' ? 'Visits' : 'Playing';
  const target = `《${emoji}》${label}: ${Math.max(0, Math.floor(Number(value) || 0))}`;
  const current = loadState();
  if (current.lastStats?.[statKey] === target) return;
  const client = new DiscordClient(token);
  try {
    const channel = await client.getChannel(channelId);
    if (channel?.name !== target) await client.renameChannel(channelId, target);
    current.lastStats = { ...(current.lastStats || {}), [statKey]: target };
    saveState();
  } catch (error) {
    log('WARN', 'Discord statistic update failed', { statKey, error: safeErrorMessage(error) });
  }
}

export function getDiscordState() { return loadState(); }
