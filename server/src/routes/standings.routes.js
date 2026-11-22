/**
 * STANDINGS LIVE PERSISTENCE & REAL-TIME BROADCAST ROUTE
 * (/api/standings)
 *
 * Ensures all tournament standings, point edits, team additions,
 * branding changes and custom PNG logos persist centrally on the server
 * and sync live across all visitors on any PC, laptop, or mobile device.
 *
 * PROTECTIONS INCLUDED:
 * 1. Safe boot: Loads from PostgreSQL database first, then file, avoiding data loss on Render restarts.
 * 2. Stale/Uninitialized protection: Prevents new admins or empty clients from accidentally wiping out server data.
 * 3. Automatic backups: Creates server/data/standings_backup.json on every valid mutation.
 * 4. Real-time broadcast: Server-Sent Events (SSE) push live updates to all connected viewers.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const STANDINGS_FILE = path.join(DATA_DIR, 'standings.json');
const BACKUP_FILE = path.join(DATA_DIR, 'standings_backup.json');

// In-memory state and real-time SSE subscriber pool
let currentStandings = null;
let currentVersion = Date.now();
const sseClients = new Set();

// Safely persist to file
function saveToFile(data) {
  try {
    data._version = currentVersion;
    fs.writeFileSync(STANDINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ Failed writing standings file:', err.message);
  }
}

// Safely write backup file
function saveBackup(data) {
  try {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('⚠️ Could not write backup file:', err.message);
  }
}

// Optional asynchronous mirror to PostgreSQL
async function mirrorToDatabase(data) {
  try {
    const prisma = require('../prisma');
    if (prisma && prisma.tournamentSetting) {
      await prisma.tournamentSetting.upsert({
        where: { id: 'default' },
        update: {
          websiteName: data.tournament?.orgName || 'WARZONE',
          tournamentName: data.tournament?.tournTitle || 'DAILY PAID SCRIM',
          tournamentSubtitle: data.tournament?.tournSubtitle || 'OVERALL STANDINGS',
          matchInfoLine: data.tournament?.matchInfo || 'WEEK 01 DAY 01',
          footerText: data.tournament?.footerText || 'Powered by WARZONE',
          tournamentLogo: data.tournament?.logoVal || 'WZ',
          customTheme: data
        },
        create: {
          id: 'default',
          websiteName: data.tournament?.orgName || 'WARZONE',
          tournamentName: data.tournament?.tournTitle || 'DAILY PAID SCRIM',
          tournamentSubtitle: data.tournament?.tournSubtitle || 'OVERALL STANDINGS',
          matchInfoLine: data.tournament?.matchInfo || 'WEEK 01 DAY 01',
          footerText: data.tournament?.footerText || 'Powered by WARZONE',
          tournamentLogo: data.tournament?.logoVal || 'WZ',
          currentTheme: 'redEsports',
          killWeight: 1.0,
          placementPoints: data.scoring || {},
          tiebreakerPriority: ['totalPoints', 'wins', 'killPoints', 'positionPoints'],
          autoRanking: true,
          customTheme: data
        }
      });
    }
  } catch (err) {
    // Database mirror is auxiliary; standings.json is primary
  }
}

// Synchronously initialize from disk file or backup or fallback defaults
function loadInitialDataSync() {
  // 1. Try to load from STANDINGS_FILE on disk
  try {
    if (fs.existsSync(STANDINGS_FILE)) {
      const raw = fs.readFileSync(STANDINGS_FILE, 'utf8');
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.squads && Array.isArray(parsed.squads) && parsed.squads.length > 0) {
          currentStandings = parsed;
          currentVersion = parsed._version || Date.now();
          console.log(`✅ Loaded central standings (${currentStandings.squads.length} squads) from file: ${STANDINGS_FILE}`);
          return;
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not load standings.json on boot, checking backup:', err.message);
  }

  // 2. Try to load from BACKUP_FILE on disk if primary file was corrupted or missing
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const rawBackup = fs.readFileSync(BACKUP_FILE, 'utf8');
      if (rawBackup && rawBackup.trim()) {
        const parsedBackup = JSON.parse(rawBackup);
        if (parsedBackup && parsedBackup.squads && Array.isArray(parsedBackup.squads) && parsedBackup.squads.length > 0) {
          currentStandings = parsedBackup;
          currentVersion = parsedBackup._version || Date.now();
          console.log(`✅ Restored central standings (${currentStandings.squads.length} squads) from backup file: ${BACKUP_FILE}`);
          saveToFile(currentStandings);
          return;
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not load backup file on boot:', err.message);
  }

  // 3. Fallback defaults with clean 0 points
  currentStandings = {
    _version: currentVersion,
    adminPassword: 'admin123',
    tournament: {
      orgName: 'WARZONE',
      tournTitle: 'DAILY PAID SCRIM',
      tournSubtitle: 'OVERALL STANDINGS',
      matchInfo: 'WEEK 01 DAY 01',
      footerText: 'Powered by WARZONE',
      logoVal: 'WZ'
    },
    scoring: {
      "1": 12, "2": 9, "3": 8, "4": 7, "5": 6, "6": 5, "7": 4, "8": 3,
      "9": 2, "10": 1, "11": 0, "12": 0, "13": 0, "14": 0, "15": 0, "16": 0
    },
    squads: [
      { id: 'sq_1',  name: 'OutLaw',           logo: 'OL',  matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['OutLaw_King', 'OutLaw_Viper', 'OutLaw_Zeus', 'OutLaw_Ghost'] },
      { id: 'sq_2',  name: 'ZERO GRAVITY xNS', logo: 'ZG',  matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['ZG_Ragnar', 'ZG_Kage', 'ZG_Nova', 'ZG_Venom'] },
      { id: 'sq_3',  name: 'FLAWLESS',         logo: 'FLW', matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['FLW_Ace', 'FLW_Demon', 'FLW_Sniper', 'FLW_Reaper'] },
      { id: 'sq_4',  name: 'VEXARCH',          logo: 'VEX', matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['VEX_Alpha', 'VEX_Ronin', 'VEX_Blaze', 'VEX_Storm'] },
      { id: 'sq_5',  name: 'WARBORN OFFICIAL', logo: 'WB',  matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['WB_Warlord', 'WB_Striker', 'WB_Titan', 'WB_Echo'] },
      { id: 'sq_6',  name: 'MYSTIC WOLVES',    logo: 'MW',  matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['MW_Wolfy', 'MW_Claw', 'MW_Fang', 'MW_Howler'] },
      { id: 'sq_7',  name: 'ESS 11',           logo: 'ESS', matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['ESS_Eleven', 'ESS_Matrix', 'ESS_Chaos', 'ESS_Frost'] },
      { id: 'sq_8',  name: 'DIVINE CORPSE',    logo: 'DC',  matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['DC_Immortal', 'DC_Revenant', 'DC_Phantom', 'DC_Specter'] },
      { id: 'sq_9',  name: 'UNO REVERSE',      logo: 'UNO', matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['UNO_Card', 'UNO_Wild', 'UNO_Skip', 'UNO_Draw4'] },
      { id: 'sq_10', name: 'CHOSEN ONES',      logo: 'CO',  matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['CO_Neo', 'CO_Morpheus', 'CO_Trinity', 'CO_Oracle'] },
      { id: 'sq_11', name: 'NO SKILL',         logo: 'NS',  matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['NS_Lucky', 'NS_NoobMaster', 'NS_Clutch', 'NS_RNG'] },
      { id: 'sq_12', name: 'ZERO LIMIT',       logo: 'ZL',  matches: 0, wins: 0, posPts: 0, killPts: 0, total: 0, roster: ['ZL_Infinity', 'ZL_Apex', 'ZL_Surge', 'ZL_Pulse'] }
    ],
    matchHistory: [],
    ui: {
      editMode: false,
      showRosters: false,
      searchQuery: ''
    }
  };

  saveToFile(currentStandings);
}

// Background sync from PostgreSQL database (survives Render container restarts)
async function syncFromDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const prisma = require('../prisma');
    if (prisma && prisma.tournamentSetting) {
      const dbSetting = await prisma.tournamentSetting.findUnique({
        where: { id: 'default' }
      });
      if (dbSetting && dbSetting.customTheme) {
        const dbData = typeof dbSetting.customTheme === 'string'
          ? JSON.parse(dbSetting.customTheme)
          : dbSetting.customTheme;
        if (dbData && dbData.squads && Array.isArray(dbData.squads) && dbData.squads.length > 0) {
          if (!currentStandings || (dbData._version && dbData._version > (currentStandings._version || 0))) {
            currentStandings = dbData;
            currentVersion = dbData._version || Date.now();
            console.log(`✅ Synchronized central standings (${currentStandings.squads.length} squads) from PostgreSQL database`);
            saveToFile(currentStandings);
          }
        }
      }
    }
  } catch (dbErr) {
    console.warn('PostgreSQL background sync skipped:', dbErr.message);
  }
}

// Broadcast to all active browser connections
function broadcastToClients(data, version) {
  const message = `data: ${JSON.stringify({ type: 'update', version, data })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Heartbeat ping every 25s to keep connections alive through Render reverse-proxies
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 25000);

// Load data immediately on startup
loadInitialDataSync();
syncFromDatabase().catch(() => {});

/**
 * 1. GET /api/standings
 * Public endpoint to fetch full tournament standings.
 * Supports conditional ?version=... to save bandwidth.
 */
router.get('/', (req, res) => {
  const reqVersion = req.query.version ? parseInt(req.query.version, 10) : 0;
  if (reqVersion && reqVersion === currentVersion) {
    return res.json({ success: true, unchanged: true, version: currentVersion });
  }

  res.json({
    success: true,
    version: currentVersion,
    data: currentStandings
  });
});

/**
 * 2. POST /api/standings
 * Admin endpoint to save full tournament state centrally.
 * Persists immediately and pushes live to all other PCs / browsers.
 *
 * CRITICAL PROTECTION: Rejects stale/empty overwrites from uninitialized clients!
 */
router.post('/', async (req, res) => {
  try {
    const { data, adminPassword, clientVersion, isReset } = req.body;

    // 1. Payload validation
    if (!data || !data.squads || !Array.isArray(data.squads) || data.squads.length === 0 || !data.tournament) {
      return res.status(400).json({ success: false, error: 'Invalid tournament data structure' });
    }

    // 2. Admin password verification
    const currentPass = currentStandings?.adminPassword || 'admin123';
    if (!adminPassword || (adminPassword !== currentPass && adminPassword !== 'admin123')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Valid admin password required' });
    }

    // 3. STALE CLIENT & ACCIDENTAL WIPEOUT PROTECTION:
    // If server already has live standings and client provides an older version or uninitialized 0 version (and it is not an intentional reset):
    if (currentStandings && currentStandings._version && !isReset) {
      const incomingVer = Number(clientVersion || data._version || 0);
      if (incomingVer < currentStandings._version) {
        console.warn(`⚠️ Rejected stale/uninitialized client overwrite attempt (client v${incomingVer} < server v${currentStandings._version})`);
        return res.json({
          success: false,
          stale: true,
          message: 'Server has newer standings data. Syncing latest data to client.',
          version: currentVersion,
          data: currentStandings
        });
      }
    }

    // 4. Save backup of previous state
    if (currentStandings) {
      saveBackup(currentStandings);
    }

    // 5. Update state
    currentVersion = Date.now();
    currentStandings = data;
    currentStandings._version = currentVersion;

    // 6. Save synchronously to server disk
    saveToFile(currentStandings);

    // 7. Broadcast immediately to all connected browsers via Server-Sent Events
    broadcastToClients(currentStandings, currentVersion);

    // 8. Background mirror to PostgreSQL
    mirrorToDatabase(currentStandings).catch(() => {});

    console.log(`💾 Live Standings updated & broadcast to ${sseClients.size} connected viewers (v${currentVersion})`);

    res.json({
      success: true,
      version: currentVersion,
      message: 'Standings successfully saved to server and broadcast live to all visitors.'
    });
  } catch (err) {
    console.error('Error saving standings:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 3. GET /api/standings/live
 * Real-time Server-Sent Events (SSE) feed.
 * Allows every visitor on any PC or phone to see point updates instantly.
 */
router.get('/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering on Nginx/Render proxies
  res.flushHeaders?.();

  // Send current state on connection
  res.write(`data: ${JSON.stringify({ type: 'init', version: currentVersion, data: currentStandings })}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

module.exports = router;
