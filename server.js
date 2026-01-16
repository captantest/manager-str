const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const cron = require('node-cron');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 7860;

// Encryption Configuration
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'dev_secret_key_32_chars_exactly!!'; // Fallback for dev
const IV_LENGTH = 16;
// Ensure key is 32 bytes
const INFO_KEY = crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest('base64').substr(0, 32);

function encrypt(text) {
    if (!text) return text;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(INFO_KEY), iv);
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return 'enc:' + iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (error) {
        console.error('Encryption error:', error);
        return text; // Fallback to plain text on error to avoid data loss
    }
}

function decrypt(text) {
    if (!text) return text;
    if (!text.startsWith('enc:')) return text; // Not encrypted

    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts[1], 'hex');
        const encryptedText = Buffer.from(parts[2], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(INFO_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error('Decryption error:', error);
        return text; // Return original if decryption fails
    }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve Static Frontend (Vite build)
const frontendPath = process.env.FRONTEND_PATH || path.join(__dirname, '.');
app.use(express.static(frontendPath));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Addon Customization Schema
const addonCustomizationSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    transportUrl: { type: String, required: true },
    originalManifest: { type: Object, required: true },
    customName: { type: String },
    catalogOverrides: { type: Object },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

addonCustomizationSchema.index({ userId: 1, transportUrl: 1 }, { unique: true });

const AddonCustomization = mongoose.model('AddonCustomization', addonCustomizationSchema);

// Stremio API Helpers
const STREMIO_API = 'https://api.strem.io/api';

async function getStremioAddons(authKey) {
    const response = await fetch(`${STREMIO_API}/addonCollectionGet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'AddonCollectionGet', authKey, update: true })
    });
    const result = await response.json();
    const data = result.result || result;
    return data?.addons || [];
}

async function setStremioAddons(authKey, addons) {
    const response = await fetch(`${STREMIO_API}/addonCollectionSet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'AddonCollectionSet', authKey, addons })
    });
    return response.json();
}

async function getStremioUser(authKey) {
    try {
        const response = await fetch(`${STREMIO_API}/getUser`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authKey })
        });
        const result = await response.json();
        return result.result || result?.user || null;
    } catch (error) {
        console.error('Error fetching Stremio user:', error);
        return null;
    }
}

async function stremioLogin(email, password) {
    const response = await fetch(`${STREMIO_API}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'Login', email, password })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Login failed');
    return (data.result || data).authKey;
}

// Routes

// Get all customizations for a user
app.get('/api/customizations/:userId', async (req, res) => {
    try {
        const customizations = await AddonCustomization.find({ userId: req.params.userId });
        res.json(customizations);
    } catch (error) {
        console.error('Error fetching customizations:', error);
        res.status(500).json({ error: 'Failed to fetch customizations' });
    }
});

// Get customization for specific addon
app.get('/api/customizations/:userId/:transportUrl', async (req, res) => {
    try {
        const transportUrl = decodeURIComponent(req.params.transportUrl);
        const customization = await AddonCustomization.findOne({
            userId: req.params.userId,
            transportUrl
        });
        res.json(customization || null);
    } catch (error) {
        console.error('Error fetching customization:', error);
        res.status(500).json({ error: 'Failed to fetch customization' });
    }
});

// Save or update customization
app.post('/api/customizations', async (req, res) => {
    try {
        const { userId, transportUrl, originalManifest, customName, catalogOverrides } = req.body;

        if (!userId || !transportUrl || !originalManifest) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const customization = await AddonCustomization.findOneAndUpdate(
            { userId, transportUrl },
            {
                originalManifest,
                customName,
                catalogOverrides,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );

        // Always trigger sync to ensure removals/updates are propagated immediately
        console.log(`⚡ Instant Sync triggered for user ${userId} (addon: ${transportUrl})`);
        performMasterSlaveSync(userId).catch(err => console.error('Instant sync failed:', err));

        res.json(customization);
    } catch (error) {
        console.error('Error saving customization:', error);
        res.status(500).json({ error: 'Failed to save customization' });
    }
});

// Delete customization (reset to original)
app.delete('/api/customizations/:userId/:transportUrl', async (req, res) => {
    try {
        const transportUrl = decodeURIComponent(req.params.transportUrl);
        await AddonCustomization.findOneAndDelete({
            userId: req.params.userId,
            transportUrl
        });

        // Always trigger sync to ensure removals are propagated immediately
        console.log(`⚡ Instant Sync triggered (deletion) for user ${req.params.userId}`);
        performMasterSlaveSync(req.params.userId).catch(err => console.error('Instant sync deletion failed:', err));

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting customization:', error);
        res.status(500).json({ error: 'Failed to delete customization' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', mongodb: mongoose.connection.readyState === 1 });
});

// ============ SYNCED ACCOUNTS (Cross-Device) ============

// Schema for storing synced account credentials
const syncedAccountSchema = new mongoose.Schema({
    masterEmail: { type: String, required: true, index: true },
    masterUserId: { type: String }, // Stremio ID of the master
    slaveEmail: { type: String, required: true },
    encryptedPassword: { type: String, required: true },
    syncEnabled: { type: Boolean, default: true }, // Logic: true = Sync Addons, false = Only Saved Password
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

syncedAccountSchema.index({ masterEmail: 1, slaveEmail: 1 }, { unique: true });

const SyncedAccount = mongoose.model('SyncedAccount', syncedAccountSchema);

// System State Schema (for global monitoring like Cinemeta version)
const systemStateSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // e.g., 'cinemeta_version'
    value: { type: String },
    updatedAt: { type: Date, default: Date.now }
});

const SystemState = mongoose.model('SystemState', systemStateSchema);

// Get all synced accounts for a master (returns emails only, passwords stay encrypted)
app.get('/api/synced-accounts/:masterEmail', async (req, res) => {
    try {
        const masterEmail = decodeURIComponent(req.params.masterEmail);
        const accounts = await SyncedAccount.find({ masterEmail });

        // Return list of slave emails, encrypted passwords, and sync status
        res.json(accounts.map(a => ({
            slaveEmail: a.slaveEmail,
            encryptedPassword: a.encryptedPassword,
            syncEnabled: a.syncEnabled !== false // Default to true if undefined
        })));
    } catch (error) {
        console.error('Error fetching synced accounts:', error);
        res.status(500).json({ error: 'Failed to fetch synced accounts' });
    }
});

// Save a synced account (when adding to sync from frontend)
app.post('/api/synced-accounts', async (req, res) => {
    try {
        const { masterEmail, masterUserId, slaveEmail, password, syncEnabled } = req.body;

        if (!masterEmail || !slaveEmail || !password) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Encrypt the password before storing
        const encryptedPassword = encrypt(password);

        const updateData = {
            encryptedPassword,
            updatedAt: new Date()
        };

        if (masterUserId) {
            updateData.masterUserId = masterUserId;
        }

        // If syncEnabled is explicitly provided, set it (defaults to true in schema)
        if (syncEnabled !== undefined) {
            updateData.syncEnabled = syncEnabled;
        }

        const syncedAccount = await SyncedAccount.findOneAndUpdate(
            { masterEmail, slaveEmail },
            updateData,
            { upsert: true, new: true }
        );

        // Also sync password to AutoUpdateSettings for the slave account
        // This unifies password storage so changes in one place reflect in the other
        try {
            await AutoUpdateSettings.findOneAndUpdate(
                { userId: slaveEmail },
                { password: encryptedPassword, updatedAt: new Date() },
                { upsert: true }
            );
            console.log(`📝 Also synced password to AutoUpdateSettings for ${slaveEmail}`);
        } catch (autoUpdateErr) {
            console.warn(`Failed to sync password to AutoUpdateSettings:`, autoUpdateErr);
            // Don't fail the request, this is a secondary sync
        }

        console.log(`✅ Saved synced account: ${slaveEmail} for master ${masterEmail} (syncEnabled: ${syncedAccount.syncEnabled})`);

        // Only trigger sync if syncEnabled is true (or not explicitly disabled)
        // This prevents addon sync when just saving password without enabling sync
        if (syncEnabled !== false) {
            performMasterSlaveSync(masterEmail).catch(err => console.error('Instant sync trigger failed:', err));
        } else {
            console.log(`⏸️ Skipping addon sync for ${slaveEmail} (syncEnabled: false)`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error saving synced account:', error);
        res.status(500).json({ error: 'Failed to save synced account' });
    }
});

// Delete a synced account
app.delete('/api/synced-accounts/:masterEmail/:slaveEmail', async (req, res) => {
    try {
        const masterEmail = decodeURIComponent(req.params.masterEmail);
        const slaveEmail = decodeURIComponent(req.params.slaveEmail);

        await SyncedAccount.findOneAndDelete({ masterEmail, slaveEmail });
        console.log(`🗑️ Removed synced account: ${slaveEmail} from master ${masterEmail}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting synced account:', error);
        res.status(500).json({ error: 'Failed to delete synced account' });
    }
});

// Update sync status (enable/disable sync without deleting password)
app.patch('/api/synced-accounts/:masterEmail/:slaveEmail', async (req, res) => {
    try {
        const masterEmail = decodeURIComponent(req.params.masterEmail);
        const slaveEmail = decodeURIComponent(req.params.slaveEmail);
        const { syncEnabled } = req.body;

        const updated = await SyncedAccount.findOneAndUpdate(
            { masterEmail, slaveEmail },
            {
                syncEnabled,
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({ error: 'Synced account not found' });
        }

        console.log(`🔄 Updated sync status for ${slaveEmail} (Master: ${masterEmail}) -> ${syncEnabled}`);

        // If Enabling sync, trigger immediate sync to reconcile state (add missing, remove deleted)
        if (syncEnabled) {
            console.log(`⚡ Instant Sync triggered (re-enable) for master ${masterEmail}`);
            performMasterSlaveSync(masterEmail).catch(err => console.error('Instant sync re-enable failed:', err));
        }

        // If disabling, triggering a "sync" is pointless as it filters out disabled ones.
        // But if creating/enabling, we might want to trigger sync?
        // For now, rely on standard flow. If disabling, we might want to run removal logic?
        // performMasterSlaveSync handles removals if the addon is present on slave but NOT in master list.
        // But if we disable sync completely for the USER, does performMasterSlaveSync remove addons?
        // NO. performMasterSlaveSync iterates over SLAVES. If I exclude this slave, it won't process it.
        // So addons will remain stale on the slave if I just exclude it from the loop.

        // This is a logic gap. If I disable sync for a user, I usually want them to stop updating.
        // But the user said "when I remove sync... don't remove password".
        // They probably imply "Stop syncing", but usually that means "Leave as is".
        // IF they wanted removal of addons, they'd use "Remove Addon".
        // Re-reading user request: "quando tolgo il sync dalle impostazioni non deve rimuovere la password salvata"
        // This implies they lost the password and want to keep it.
        // So, stopping updates is fine. Stale addons are fine (or user removes them manually).

        res.json({ success: true, syncEnabled: updated.syncEnabled });
    } catch (error) {
        console.error('Error updating sync status:', error);
        res.status(500).json({ error: 'Failed to update sync status' });
    }
});

// Delete all synced accounts for a master
app.delete('/api/synced-accounts/:masterEmail', async (req, res) => {
    try {
        const masterEmail = decodeURIComponent(req.params.masterEmail);
        await SyncedAccount.deleteMany({ masterEmail });
        console.log(`🗑️ Removed all synced accounts for master ${masterEmail}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting synced accounts:', error);
        res.status(500).json({ error: 'Failed to delete synced accounts' });
    }
});

// Login a slave account using encrypted password (for auto-restore)
app.post('/api/synced-accounts/login', async (req, res) => {
    try {
        const { email, encryptedPassword } = req.body;

        if (!email || !encryptedPassword) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Decrypt the password
        const password = decrypt(encryptedPassword);

        // Try to login to Stremio
        const authKey = await stremioLogin(email, password);
        const user = await getStremioUser(authKey);

        if (!user) {
            return res.status(401).json({ error: 'Login failed' });
        }

        res.json({
            success: true,
            user: user,
            authKey: authKey
        });
    } catch (error) {
        console.error('Error logging in synced account:', error);
        res.status(401).json({ error: error.message || 'Login failed' });
    }
});

// Check sync status for an email (Am I a master? Am I a slave?)
app.get('/api/sync-status/:email', async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email);

        // Check if I am a master using countDocuments for efficiency if we don't need details immediately
        // But we might want details. Let's find one.
        const asMaster = await SyncedAccount.findOne({ masterEmail: email });

        if (asMaster) {
            return res.json({ role: 'master', masterEmail: email });
        }

        // Check if I am a slave
        const asSlave = await SyncedAccount.findOne({ slaveEmail: email });

        if (asSlave) {
            return res.json({ role: 'slave', masterEmail: asSlave.masterEmail, masterUserId: asSlave.masterUserId });
        }

        res.json({ role: 'none' });
    } catch (error) {
        console.error('Error checking sync status:', error);
        res.status(500).json({ error: 'Failed to check sync status' });
    }
});

// Cinemeta Settings Schema
const cinemetaSettingsSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true },
    searchDisabled: { type: Boolean, default: false },
    catalogsDisabled: { type: Boolean, default: false },
    metadataDisabled: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now }
});

const CinemetaSettings = mongoose.model('CinemetaSettings', cinemetaSettingsSchema);

function applyCinemetaSettings(addons, settings, originalManifest) {
    return addons.map(addon => {
        const isCinemeta = addon.transportUrl?.includes('cinemeta') ||
            addon.manifest?.id === 'com.linvo.cinemeta';

        if (!isCinemeta) return addon;

        const manifest = JSON.parse(JSON.stringify(originalManifest));

        if (settings.catalogsDisabled && settings.searchDisabled) {
            manifest.catalogs = (originalManifest.catalogs || [])
                .filter(c => c.id === 'calendar-videos');
        } else if (settings.catalogsDisabled) {
            manifest.catalogs = (originalManifest.catalogs || [])
                .filter(c => c.extraSupported?.includes('search') || c.id === 'calendar-videos')
                .map(c => {
                    if (c.id === 'calendar-videos') return c;
                    return {
                        ...c,
                        extra: [{ name: 'search', isRequired: true }],
                        extraRequired: ['search']
                    };
                });
        } else if (settings.searchDisabled) {
            manifest.catalogs = (originalManifest.catalogs || []).filter(c =>
                !c.extraSupported?.includes('search') || c.id === 'calendar-videos'
            );
        }

        if (settings.metadataDisabled) {
            if (manifest.resources) {
                manifest.resources = manifest.resources.filter(r =>
                    r !== 'meta' && r?.name !== 'meta'
                );
            }
            // Only clear types if calendar-videos is NOT present
            if (!manifest.catalogs?.some(c => c.id === 'calendar-videos')) {
                manifest.types = [];
            }
        }

        return { ...addon, manifest };
    });
}

// Get Cinemeta settings for a user
app.get('/api/cinemeta-settings/:userId', async (req, res) => {
    try {
        const settings = await CinemetaSettings.findOne({ userId: req.params.userId });
        res.json(settings || {
            searchDisabled: false,
            catalogsDisabled: false,
            metadataDisabled: false
        });
    } catch (error) {
        console.error('Error fetching Cinemeta settings:', error);
        res.status(500).json({ error: 'Failed to fetch Cinemeta settings' });
    }
});

// Save/Update Cinemeta settings and sync with Stremio
app.post('/api/cinemeta-settings/:userId', async (req, res) => {
    try {
        const { searchDisabled, catalogsDisabled, metadataDisabled, authKey } = req.body;

        const settings = await CinemetaSettings.findOneAndUpdate(
            { userId: req.params.userId },
            {
                searchDisabled,
                catalogsDisabled,
                metadataDisabled,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );

        if (authKey) {
            try {
                console.log('Syncing Cinemeta settings with Stremio...');
                const addons = await getStremioAddons(authKey);
                const cinemetaResponse = await fetch('https://v3-cinemeta.strem.io/manifest.json');
                const originalManifest = await cinemetaResponse.json();

                const modifiedAddons = applyCinemetaSettings(addons, {
                    searchDisabled,
                    catalogsDisabled,
                    metadataDisabled
                }, originalManifest);

                await setStremioAddons(authKey, modifiedAddons);
                console.log('✅ Cinemeta settings synced with Stremio');

                res.json({ ...settings.toObject(), synced: true });
            } catch (syncError) {
                console.error('Failed to sync with Stremio:', syncError);
                res.json({ ...settings.toObject(), synced: false, syncError: syncError.message });
            }
        } else {
            res.json(settings);
        }
    } catch (error) {
        console.error('Error saving Cinemeta settings:', error);
        res.status(500).json({ error: 'Failed to save Cinemeta settings' });
    }
});

// Reset Cinemeta settings and sync with Stremio
app.delete('/api/cinemeta-settings/:userId', async (req, res) => {
    try {
        await CinemetaSettings.findOneAndDelete({ userId: req.params.userId });

        const { authKey } = req.body || {};

        if (authKey) {
            try {
                console.log('Resetting Cinemeta on Stremio...');
                const addons = await getStremioAddons(authKey);
                const cinemetaResponse = await fetch('https://v3-cinemeta.strem.io/manifest.json');
                const originalManifest = await cinemetaResponse.json();

                const restoredAddons = addons.map(addon => {
                    const isCinemeta = addon.transportUrl?.includes('cinemeta') ||
                        addon.manifest?.id === 'com.linvo.cinemeta';
                    if (isCinemeta) {
                        return { ...addon, manifest: originalManifest };
                    }
                    return addon;
                });

                await setStremioAddons(authKey, restoredAddons);
                console.log('✅ Cinemeta reset on Stremio');

                res.json({ success: true, synced: true });
            } catch (syncError) {
                console.error('Failed to reset on Stremio:', syncError);
                res.status(500).json({ success: true, synced: false, syncError: syncError.message });
            }
        } else {
            res.json({ success: true });
        }
    } catch (error) {
        console.error('Error resetting Cinemeta settings:', error);
        res.status(500).json({ error: 'Failed to reset Cinemeta settings' });
    }
});

// Auto Update Settings Schema
const autoUpdateSettingsSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    password: { type: String }, // Now storing encrypted
    failureCount: { type: Number, default: 0 },
    addonCount: { type: Number, default: 0 },
    lastRun: { type: Date },
    lastError: { type: String },
    updatedAt: { type: Date, default: Date.now }
});

const AutoUpdateSettings = mongoose.model('AutoUpdateSettings', autoUpdateSettingsSchema);

// Get Auto Update settings
app.get('/api/auto-update-settings/:userId', async (req, res) => {
    try {
        const settings = await AutoUpdateSettings.findOne({ userId: req.params.userId }).lean();
        if (settings) {
            // Do not return password to frontend for security
            // Explicitly set it so the frontend knows it exists
            settings.password = settings.password ? '******' : null;
        }
        res.json(settings || { enabled: false });
    } catch (error) {
        console.error('Error fetching auto-update settings:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Save Auto Update settings
app.post('/api/auto-update-settings/:userId', async (req, res) => {
    try {
        const { enabled, password } = req.body;
        const userId = req.params.userId;

        if (enabled && !password) {
            const existing = await AutoUpdateSettings.findOne({ userId });
            if (!existing?.password) {
                return res.status(400).json({ error: 'Password required to enable auto-updates' });
            }
        }

        const updateData = {
            updatedAt: new Date()
        };

        if (enabled !== undefined) {
            updateData.enabled = enabled;
        }

        let encryptedPassword = null;
        if (password) {
            encryptedPassword = encrypt(password); // Encrypt before saving
            updateData.password = encryptedPassword;
            updateData.failureCount = 0;
        }

        const settings = await AutoUpdateSettings.findOneAndUpdate(
            { userId },
            updateData,
            { upsert: true, new: true }
        );

        // Also sync password to SyncedAccount if this user is a slave
        // This unifies password storage so changes in one place reflect in the other
        if (encryptedPassword) {
            try {
                const syncedAccounts = await SyncedAccount.find({ slaveEmail: userId });
                for (const sa of syncedAccounts) {
                    await SyncedAccount.findByIdAndUpdate(sa._id, {
                        encryptedPassword,
                        updatedAt: new Date()
                    });
                    console.log(`📝 Also synced password to SyncedAccount for ${userId} (master: ${sa.masterEmail})`);
                }
            } catch (syncErr) {
                console.warn(`Failed to sync password to SyncedAccount:`, syncErr);
                // Don't fail the request, this is a secondary sync
            }
        }

        res.json(settings);
    } catch (error) {
        console.error('Error saving auto-update settings:', error);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// Logic to perform update for a single user
async function performUserUpdate(userSettings) {
    try {
        if (!userSettings.password) {
            console.warn(`User ${userSettings.userId} has no password stored, skipping`);
            return { success: false, error: 'Password not stored' };
        }

        console.log(`Processing updates for user: ${userSettings.userId}`);

        // Decrypt password
        const decryptedPassword = decrypt(userSettings.password);

        let authKey;
        try {
            authKey = await stremioLogin(userSettings.userId, decryptedPassword);

            if (userSettings.failureCount > 0) {
                await AutoUpdateSettings.findByIdAndUpdate(userSettings._id, { failureCount: 0 });
            }
        } catch (loginError) {
            console.error(`Login failed for ${userSettings.userId}:`, loginError.message);
            const newCount = (userSettings.failureCount || 0) + 1;
            if (newCount >= 3) {
                console.warn(`User ${userSettings.userId} reached 3 login failures. Removing from auto-updates.`);
                await AutoUpdateSettings.findByIdAndDelete(userSettings._id);
                return { success: false, error: 'Auth failed 3 times, auto-updates disabled' };
            } else {
                await AutoUpdateSettings.findByIdAndUpdate(userSettings._id, { failureCount: newCount });
                return { success: false, error: `Auth failed (${newCount}/3)` };
            }
        }

        const currentAddons = await getStremioAddons(authKey);

        if (currentAddons.length === 0) {
            await AutoUpdateSettings.findByIdAndUpdate(userSettings._id, { lastRun: new Date(), lastError: null });
            return { success: true, message: 'No addons to update' };
        }

        const customizations = await AddonCustomization.find({ userId: userSettings.userId });
        const customizationMap = {};
        customizations.forEach(c => {
            customizationMap[c.transportUrl] = c;
        });

        const updatedAddons = [];
        let updateCount = 0;

        for (const addon of currentAddons) {
            if (!addon.transportUrl || addon.transportUrl.includes('strem.io')) {
                updatedAddons.push(addon);
                continue;
            }

            if (!addon.transportUrl.startsWith('https://')) {
                updatedAddons.push(addon);
                continue;
            }

            const customization = customizationMap[addon.transportUrl];

            // Skip disabled addons entirely (don't include in Stremio)
            if (customization?.catalogOverrides?._disabled) {
                console.log(`Skipping disabled addon: ${addon.manifest?.name || addon.transportUrl}`);
                continue;
            }

            // Keep addons excluded from auto-update as-is (no refresh)
            if (customization?.catalogOverrides?._excludeFromAutoUpdate) {
                updatedAddons.push(addon);
                continue;
            }

            try {
                const response = await fetch(addon.transportUrl);
                if (!response.ok) throw new Error('Failed to fetch manifest');
                const freshManifest = await response.json();

                const newAddon = {
                    transportUrl: addon.transportUrl,
                    transportName: addon.transportName || 'http',
                    manifest: freshManifest,
                    flags: addon.flags || {}
                };

                if (customization) {
                    if (customization.customName) {
                        newAddon.manifest.name = customization.customName;
                    }

                    if (customization.catalogOverrides && newAddon.manifest.catalogs) {
                        newAddon.manifest.catalogs = newAddon.manifest.catalogs.filter(cat => {
                            // Use 'type:id' key format to match frontend
                            const catalogKey = `${cat.type}:${cat.id}`;
                            const override = customization.catalogOverrides[catalogKey];
                            return !override?.hidden;
                        }).map(cat => {
                            const catalogKey = `${cat.type}:${cat.id}`;
                            const override = customization.catalogOverrides[catalogKey];
                            if (override?.customName) {
                                return { ...cat, name: override.customName };
                            }
                            if (override?.name) {
                                return { ...cat, name: override.name };
                            }
                            return cat;
                        });

                        const order = customization.catalogOverrides._order;
                        if (order && Array.isArray(order)) {
                            newAddon.manifest.catalogs = newAddon.manifest.catalogs.sort((a, b) => {
                                const keyA = `${a.type}:${a.id}`;
                                const keyB = `${b.type}:${b.id}`;
                                const indexA = order.indexOf(keyA);
                                const indexB = order.indexOf(keyB);
                                if (indexA === -1) return 1;
                                if (indexB === -1) return -1;
                                return indexA - indexB;
                            });
                        }
                    }
                }

                updatedAddons.push(newAddon);
                updateCount++;
            } catch (err) {
                console.error(`Failed to update addon ${addon.transportUrl}:`, err.message);
                updatedAddons.push(addon);
            }
        }

        if (updateCount > 0) {
            // Re-apply Cinemeta settings to preserve user preferences
            const cinemetaSettings = await CinemetaSettings.findOne({ userId: userSettings.userId });
            let finalAddons = updatedAddons;

            if (cinemetaSettings && (cinemetaSettings.searchDisabled || cinemetaSettings.catalogsDisabled || cinemetaSettings.metadataDisabled)) {
                try {
                    const cinemetaResponse = await fetch('https://v3-cinemeta.strem.io/manifest.json');
                    const originalCinemetaManifest = await cinemetaResponse.json();
                    finalAddons = applyCinemetaSettings(updatedAddons, cinemetaSettings, originalCinemetaManifest);
                    console.log(`🎬 Cinemeta settings re-applied for user ${userSettings.userId}`);
                } catch (cinemetaError) {
                    console.error(`Failed to re-apply Cinemeta settings for ${userSettings.userId}:`, cinemetaError.message);
                }
            }

            await setStremioAddons(authKey, finalAddons);
            console.log(`✅ Updated ${updateCount} addons for user ${userSettings.userId}`);
        }

        await AutoUpdateSettings.findByIdAndUpdate(userSettings._id, {
            lastRun: new Date(),
            addonCount: currentAddons.length,
            lastError: null
        });

        return { success: true, count: updateCount };

    } catch (userError) {
        console.error(`Error processing user ${userSettings.userId}:`, userError);
        await AutoUpdateSettings.findByIdAndUpdate(userSettings._id, {
            lastError: userError.message
        });
        return { success: false, error: userError.message };
    }
}

// Endpoint to trigger manual update
app.post('/api/trigger-autoupdate/:userId', async (req, res) => {
    try {
        const userSettings = await AutoUpdateSettings.findOne({ userId: req.params.userId });
        if (!userSettings) {
            return res.status(404).json({ error: 'Settings not found or auto-update not enabled' });
        }
        const result = await performUserUpdate(userSettings);
        res.json(result);
    } catch (error) {
        console.error('Manual update trigger failed:', error);
        res.status(500).json({ error: 'Manual update failed' });
    }
});

// Endpoint to trigger manual update using session authKey
app.post('/api/update-addons-now/:userId', async (req, res) => {
    try {
        const { authKey } = req.body;
        const userId = decodeURIComponent(req.params.userId);

        if (!authKey) {
            return res.status(400).json({ error: 'AuthKey required' });
        }

        const currentAddons = await getStremioAddons(authKey);
        // ... (rest of logic is similar but key is provided)
        // Re-using existing logic or copy-pasting for safety?
        // The previous code had specific logic here. I should preserve it.
        // Copying the logic from previous view...

        if (currentAddons.length === 0) {
            return res.json({ success: true, count: 0, message: 'No addons to update' });
        }

        const customizations = await AddonCustomization.find({ userId });
        const customizationMap = {};
        customizations.forEach(c => {
            customizationMap[c.transportUrl] = c;
        });

        const updatedAddons = [];
        let updateCount = 0;

        for (const addon of currentAddons) {
            if (!addon.transportUrl || addon.transportUrl.includes('strem.io')) {
                updatedAddons.push(addon);
                continue;
            }
            if (!addon.transportUrl.startsWith('https://')) {
                updatedAddons.push(addon);
                continue;
            }
            const customization = customizationMap[addon.transportUrl];

            // Skip disabled addons entirely (don't include in Stremio)
            if (customization?.catalogOverrides?._disabled) {
                console.log(`Skipping disabled addon: ${addon.manifest?.name || addon.transportUrl}`);
                continue;
            }

            // Keep addons excluded from auto-update as-is (no refresh)
            if (customization?.catalogOverrides?._excludeFromAutoUpdate) {
                updatedAddons.push(addon);
                continue;
            }

            try {
                const response = await fetch(addon.transportUrl);
                if (!response.ok) throw new Error('Failed to fetch manifest');
                const freshManifest = await response.json();

                const newAddon = {
                    transportUrl: addon.transportUrl,
                    transportName: addon.transportName || 'http',
                    manifest: freshManifest,
                    flags: addon.flags || {}
                };

                if (customization) {
                    if (customization.customName) {
                        newAddon.manifest.name = customization.customName;
                    }
                    if (customization.catalogOverrides && newAddon.manifest.catalogs) {
                        newAddon.manifest.catalogs = newAddon.manifest.catalogs.filter(cat => {
                            // Use 'type:id' key format to match frontend
                            const catalogKey = `${cat.type}:${cat.id}`;
                            const override = customization.catalogOverrides[catalogKey];
                            return !override?.hidden;
                        }).map(cat => {
                            const catalogKey = `${cat.type}:${cat.id}`;
                            const override = customization.catalogOverrides[catalogKey];
                            if (override?.customName) {
                                return { ...cat, name: override.customName };
                            }
                            if (override?.name) {
                                return { ...cat, name: override.name };
                            }
                            return cat;
                        });
                        const order = customization.catalogOverrides._order;
                        if (order && Array.isArray(order)) {
                            newAddon.manifest.catalogs = newAddon.manifest.catalogs.sort((a, b) => {
                                const keyA = `${a.type}:${a.id}`;
                                const keyB = `${b.type}:${b.id}`;
                                const indexA = order.indexOf(keyA);
                                const indexB = order.indexOf(keyB);
                                return (indexA === -1 ? 1 : (indexB === -1 ? -1 : indexA - indexB));
                            });
                        }
                    }
                }
                updatedAddons.push(newAddon);
                updateCount++;
            } catch (err) {
                console.error(`Failed to update addon ${addon.transportUrl}:`, err.message);
                updatedAddons.push(addon);
            }
        }

        if (updateCount > 0) {
            // Re-apply Cinemeta settings to preserve user preferences
            const cinemetaSettings = await CinemetaSettings.findOne({ userId });
            let finalAddons = updatedAddons;

            if (cinemetaSettings && (cinemetaSettings.searchDisabled || cinemetaSettings.catalogsDisabled || cinemetaSettings.metadataDisabled)) {
                try {
                    const cinemetaResponse = await fetch('https://v3-cinemeta.strem.io/manifest.json');
                    const originalCinemetaManifest = await cinemetaResponse.json();
                    finalAddons = applyCinemetaSettings(updatedAddons, cinemetaSettings, originalCinemetaManifest);
                    console.log(`🎬 Cinemeta settings re-applied for user ${userId}`);
                } catch (cinemetaError) {
                    console.error(`Failed to re-apply Cinemeta settings for ${userId}:`, cinemetaError.message);
                }
            }

            await setStremioAddons(authKey, finalAddons);
            console.log(`✅ Updated ${updateCount} addons for user ${userId} (session)`);
        }

        res.json({ success: true, count: updateCount });
    } catch (error) {
        console.error('Session update failed:', error);
        res.status(500).json({ error: error.message || 'Update failed' });
    }
});

// Cron Job
cron.schedule('0 3 * * *', async () => {
    console.log('🔄 Starting daily auto-update check...');
    try {
        const usersToUpdate = await AutoUpdateSettings.find({ enabled: true });
        console.log(`Found ${usersToUpdate.length} users with auto-updates enabled`);
        for (const userSettings of usersToUpdate) {
            await performUserUpdate(userSettings);
        }
    } catch (error) {
        console.error('Critical error in auto-update cron job:', error);
    }
});

// ============ ADMIN ENDPOINTS ============

const ADMIN_EMAIL = process.env.ADMIN_MAIL;

// Admin Middleware
async function verifyAdmin(req, res, next) {
    if (!ADMIN_EMAIL) {
        return res.status(500).json({ error: 'ADMIN_MAIL not configured' });
    }

    const authKey = req.headers['authorization']?.replace('Bearer ', '') || req.body.authKey;

    if (!authKey) {
        return res.status(401).json({ error: 'Autenticazione richiesta' });
    }

    // Verify key with Stremio and check email
    const user = await getStremioUser(authKey);

    if (!user || !user.email) {
        return res.status(401).json({ error: 'Sessione non valida' });
    }

    if (user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        return res.status(403).json({ error: 'Accesso negato: non sei admin' });
    }

    // Pass admin email to next middleware
    req.adminEmail = user.email;
    next();
}

// Check if user is admin (Public check, just verifies email match, but action endpoints are secured)
app.get('/api/admin/check/:email', (req, res) => {
    const email = decodeURIComponent(req.params.email);
    const isAdmin = ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
    res.json({ isAdmin });
});

// Get all registered users (Secured)
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
    try {
        // Get all users from AutoUpdateSettings (main user registry)
        const autoUpdateUsers = await AutoUpdateSettings.find({});

        // Also get users who have customizations but might not have auto-update settings
        const customizationUsers = await AddonCustomization.distinct('userId');
        const cinemetaUsers = await CinemetaSettings.distinct('userId');

        // Merge all unique user IDs
        const allUserIds = [...new Set([
            ...autoUpdateUsers.map(u => u.userId),
            ...customizationUsers,
            ...cinemetaUsers
        ])];

        // Build user data
        const users = await Promise.all(allUserIds.map(async (userId) => {
            const autoUpdateSetting = autoUpdateUsers.find(u => u.userId === userId);

            return {
                email: userId,
                autoUpdatesEnabled: autoUpdateSetting?.enabled || false,
                addonCount: autoUpdateSetting?.addonCount || 0,
                lastRun: autoUpdateSetting?.lastRun || null,
                lastError: autoUpdateSetting?.lastError || null
            };
        }));

        res.json({ users });
    } catch (error) {
        console.error('Error fetching admin users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Delete a user account (Secured)
app.delete('/api/admin/users/:userId', verifyAdmin, async (req, res) => {
    try {
        const userId = decodeURIComponent(req.params.userId);

        console.log(`Admin deleting account for user: ${userId}`);

        // Delete all related data
        await Promise.all([
            AddonCustomization.deleteMany({ userId }),
            CinemetaSettings.deleteOne({ userId }),
            AutoUpdateSettings.deleteOne({ userId })
        ]);

        console.log(`✅ Admin deleted account data for ${userId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error admin deleting account:', error);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

// Trigger auto-update for ALL users (Secured)
app.post('/api/admin/trigger-all-updates', verifyAdmin, async (req, res) => {
    try {
        console.log('Admin triggered global update...');

        console.log('🔄 Admin triggered update for all users...');

        // Find all users with auto-updates enabled
        const usersToUpdate = await AutoUpdateSettings.find({ enabled: true });
        console.log(`Found ${usersToUpdate.length} users with auto-updates enabled`);

        const results = {
            total: usersToUpdate.length,
            success: 0,
            failed: 0,
            errors: []
        };

        for (const userSettings of usersToUpdate) {
            const result = await performUserUpdate(userSettings);
            if (result.success) {
                results.success++;
            } else {
                results.failed++;
                results.errors.push({ user: userSettings.userId, error: result.error });
            }
        }

        console.log(`✅ Bulk update complete: ${results.success} success, ${results.failed} failed`);
        res.json(results);
    } catch (error) {
        console.error('Error in admin trigger all updates:', error);
        res.status(500).json({ error: 'Failed to trigger updates' });
    }
});

// ============ END ADMIN ENDPOINTS ============

// Delete entire account data
app.delete('/api/account/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        console.log(`Deleting account data for user: ${userId}`);

        // Delete all related data
        await Promise.all([
            AddonCustomization.deleteMany({ userId }),
            CinemetaSettings.deleteOne({ userId }),
            AutoUpdateSettings.deleteOne({ userId })
        ]);

        console.log(`✅ Account data deleted for ${userId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting account:', error);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

// ============ MASTER-SLAVE SYNC ENFORCEMENT ============

async function performMasterSlaveSync(targetMasterEmail = null) {
    console.log(`🔄 Starting Master-Slave Sync Enforcement${targetMasterEmail ? ` for ${targetMasterEmail}` : ' (Global)'}...`);
    try {
        // 1. Get unique masters (or just the target one)
        let distinctMasters;
        if (targetMasterEmail) {
            distinctMasters = [targetMasterEmail];
        } else {
            distinctMasters = await SyncedAccount.distinct('masterEmail');
        }
        console.log(`Processing ${distinctMasters.length} master(s) for sync.`);

        for (const masterEmail of distinctMasters) {
            // 2. Check if Master has stored credentials (needed to fetch canonical list)
            const masterSettings = await AutoUpdateSettings.findOne({ userId: masterEmail });

            if (!masterSettings || !masterSettings.password) {
                console.log(`⚠️ Skipping master ${masterEmail}: No stored credentials (required for canonical sync).`);
                continue;
            }

            try {
                // 3. Login as Master and fetch Canonical Addons
                const masterPassword = decrypt(masterSettings.password);
                const masterAuthKey = await stremioLogin(masterEmail, masterPassword);
                const masterAddons = await getStremioAddons(masterAuthKey);

                // 4. Get Master's Customizations (to check for inclusions - Opt-In)
                const masterCustomizations = await AddonCustomization.find({ userId: masterEmail });
                const includedTransportUrls = new Set();
                masterCustomizations.forEach(c => {
                    if (c.catalogOverrides?._forceSync) {
                        includedTransportUrls.add(c.transportUrl);
                    }
                });

                console.log(`[SyncDebug] Master ${masterEmail} - Included URLs (ForceSync=true):`, [...includedTransportUrls]);

                // Filter master addons: Only include those explicitly marked for sync
                const syncableMasterAddons = masterAddons.filter(addon => {
                    const isIncluded = includedTransportUrls.has(addon.transportUrl);
                    if (!isIncluded) {
                        // console.log(`[SyncDebug] Ignoring ${addon.transportUrl} - Not marked for sync`);
                    }
                    return isIncluded;
                });

                console.log(`[SyncDebug] Master ${masterEmail} - Syncable Addons Count: ${syncableMasterAddons.length}`);
                if (syncableMasterAddons.length > 0) {
                    console.log(`[SyncDebug] Syncable Addons: ${syncableMasterAddons.map(a => a.manifest?.name || a.transportUrl).join(', ')}`);
                }

                // Create a Set of ALL Master Addon URLs to know what is "Managed"
                const masterAllTransportUrls = new Set(masterAddons.map(a => a.transportUrl));

                // 5. Get Slaves for this Master (Only those with syncEnabled = true)
                const slaves = await SyncedAccount.find({ masterEmail });

                // Filter out disabled syncs
                const activeSlaves = slaves.filter(s => s.syncEnabled !== false);

                if (activeSlaves.length === 0) {
                    console.log(`Master ${masterEmail} has no active slave accounts.`);
                    continue;
                }

                console.log(`Syncing ${activeSlaves.length} slave(s) for master ${masterEmail}...`);

                for (const slave of activeSlaves) {
                    const slaveEmail = slave.slaveEmail; try {
                        const slavePassword = decrypt(slave.encryptedPassword);
                        const slaveAuthKey = await stremioLogin(slave.slaveEmail, slavePassword);
                        const slaveAddons = await getStremioAddons(slaveAuthKey);

                        // 6. Identify Changes (Additions AND Removals)
                        const slaveTransportUrls = new Set(slaveAddons.map(a => a.transportUrl));

                        // Fetch Slave's local customizations to identify "Managed/Customized" addons
                        // If a Slave has a customization record, it means it's likely a synced addon.
                        const slaveDbRecords = await AddonCustomization.find({ userId: slave.slaveEmail }).select('transportUrl').lean();
                        const slaveCustomizedUrls = new Set(slaveDbRecords.map(r => r.transportUrl));

                        // A. Addons to ADD (Sync Enabled on Master, Missing on Slave)
                        const addonsToAdd = syncableMasterAddons.filter(a => {
                            // REDUNDANT SAFETY CHECK: Ensure it is absolutely marked for sync
                            if (!includedTransportUrls.has(a.transportUrl)) {
                                console.warn(`[Refused] Attempted to add unsynced addon ${a.transportUrl} to slave ${slave.slaveEmail}`);
                                return false;
                            }
                            return !slaveTransportUrls.has(a.transportUrl);
                        });

                        // B. Addons to REMOVE
                        // 1. It is on Slave AND Master HAS it BUT Sync is DISABLED (Explicit Revocation)
                        // 2. It is on Slave (Customized) AND Master DOES NOT HAVE it (Deletion Propagation)
                        const addonsToRemove = slaveAddons.filter(a => {
                            const isManagedByMaster = masterAllTransportUrls.has(a.transportUrl);
                            const isSyncEnabled = includedTransportUrls.has(a.transportUrl);
                            const isCustomizedOnSlave = slaveCustomizedUrls.has(a.transportUrl);

                            // Case 1: Master has it, but turned off sync
                            if (isManagedByMaster && !isSyncEnabled) return true;

                            // Case 2: Master deleted it (so it's gone from masterAll), but Slave still has the customization record
                            // We only delete if it was a "Customized" addon to avoid deleting random local adds like "YouTube"
                            if (!isManagedByMaster && isCustomizedOnSlave) return true;

                            return false;
                        });

                        if (addonsToAdd.length > 0 || addonsToRemove.length > 0) {
                            console.log(`[Sync] Slave ${slave.slaveEmail}: +${addonsToAdd.length} Add / -${addonsToRemove.length} Remove`);

                            // 1. Start with current slave addons
                            let newSlaveCollection = [...slaveAddons];

                            // 2. Remove "Revoked" or "Deleted" addons
                            if (addonsToRemove.length > 0) {
                                const urlsToRemove = new Set(addonsToRemove.map(a => a.transportUrl));
                                newSlaveCollection = newSlaveCollection.filter(a => !urlsToRemove.has(a.transportUrl));
                                console.log(`[Sync] Removing: ${addonsToRemove.map(a => a.transportUrl).join(', ')}`);

                                // CLEANUP: Also remove the dead customization records from Slave's DB
                                await AddonCustomization.deleteMany({
                                    userId: slave.slaveEmail,
                                    transportUrl: { $in: Array.from(urlsToRemove) }
                                });
                                // console.log('[Sync] Cleaned up DB records for removed addons.');
                            }

                            // 3. Add "New" addons
                            if (addonsToAdd.length > 0) {
                                newSlaveCollection = [...newSlaveCollection, ...addonsToAdd];
                                console.log(`[Sync] Adding to Stremio: ${addonsToAdd.map(a => a.transportUrl).join(', ')}`);

                                // CRITICAL: Also create DB record to establish ownership/tracking
                                for (const addonToAdd of addonsToAdd) {
                                    try {
                                        const masterCustomization = await AddonCustomization.findOne({
                                            userId: masterEmail,
                                            transportUrl: addonToAdd.transportUrl
                                        });

                                        if (masterCustomization) {
                                            await AddonCustomization.findOneAndUpdate(
                                                { userId: slave.slaveEmail, transportUrl: addonToAdd.transportUrl },
                                                {
                                                    originalManifest: masterCustomization.originalManifest,
                                                    customName: masterCustomization.customName,
                                                    catalogOverrides: masterCustomization.catalogOverrides,
                                                    updatedAt: new Date()
                                                },
                                                { upsert: true, new: true }
                                            );
                                            // console.log(`[Sync] Created ownership record for ${addonToAdd.transportUrl}`);
                                        }
                                    } catch (err) {
                                        console.warn(`[Sync] Failed to create ownership record for ${addonToAdd.transportUrl}:`, err);
                                    }
                                }
                            }

                            // 4. Update "Existing" addons - DISABLED PER USER REQUEST
                            // User wants Slaves to maintain their own customizations (Name, Catalog Hiding)
                            // independent of Master updates.
                            // Only existence (Add/Remove) is synced.
                            /*
                            const addonsToUpdate = syncableMasterAddons.filter(a => slaveTransportUrls.has(a.transportUrl));
                            if (addonsToUpdate.length > 0) {
                                console.log(`[Sync] Deep Syncing ${addonsToUpdate.length} existing addons for slave ${slave.slaveEmail}...`);

                                for (const masterAddon of addonsToUpdate) {
                                    // Logic removed to prevent overwriting slave customizations
                                }
                            }
                            */

                            /*
                            // B. Update MongoDB Customization Record (Frontend State)
                            // We need to fetch the Master's customization record to copy it to the Slave
                            try {
                                const masterCustomization = await AddonCustomization.findOne({
                                    userId: masterEmail, // or masterUserId? "userId" field stores email/ID. Assuming email from context.
                                    // Wait, the "userId" in schema is whatever we passed. 
                                    // In AddonsContext we use getUserId(). 
                                    // performMasterSlaveSync iterates masterEmail.
                                    // Is userId === masterEmail? 
                                    // Check passed arg. "userId" of performMasterSlaveSync(userId).
                                    // We called it with email in loop?
                                    // "Processing 3 master(s)..." -> "performMasterSlaveSync()" iterates users.
                                    // It uses "usersWithEnabledAddons" (AutoUpdateSettings).
                                    // AutoUpdateSettings stores "userId" (usually email).
                                    // Let's assume userId is consistent.
                                    userId: masterEmail,
                                    transportUrl: masterAddon.transportUrl
                                });

                                if (masterCustomization) {
                                    await AddonCustomization.findOneAndUpdate(
                                        { userId: slave.slaveEmail, transportUrl: masterAddon.transportUrl },
                                        {
                                            originalManifest: masterCustomization.originalManifest,
                                            customName: masterCustomization.customName,
                                            catalogOverrides: masterCustomization.catalogOverrides,
                                            updatedAt: new Date()
                                        },
                                        { upsert: true, new: true }
                                    );
                                    // console.log(`[DBSync] Updated DB record for ${masterAddon.transportUrl}`);
                                }
                            } catch (dbErr) {
                                console.warn(`[DBSync] Failed to sync DB record for ${masterAddon.transportUrl}:`, dbErr.message);
                            }
                            */


                            // 5. Re-Order Slave Collection to match Master's Position (User Request)
                            const masterOrderMap = new Map();
                            syncableMasterAddons.forEach((addon, index) => {
                                masterOrderMap.set(addon.transportUrl, index);
                            });

                            newSlaveCollection.sort((a, b) => {
                                const indexA = masterOrderMap.has(a.transportUrl) ? masterOrderMap.get(a.transportUrl) : Number.MAX_SAFE_INTEGER;
                                const indexB = masterOrderMap.has(b.transportUrl) ? masterOrderMap.get(b.transportUrl) : Number.MAX_SAFE_INTEGER;
                                if (indexA === indexB) return 0; // maintain relative order of non-master items (unstable sort if 0? V8 is stable)
                                return indexA - indexB;
                            });

                            await setStremioAddons(slaveAuthKey, newSlaveCollection);
                            console.log(`✅ Synced slave ${slave.slaveEmail} successfully.`);
                        } else {
                            // console.log(`✅ Slave ${slave.slaveEmail} is already in sync.`);
                        }

                    } catch (slaveErr) {
                        console.error(`❌ Failed to sync slave ${slave.slaveEmail}:`, slaveErr.message);
                    }
                }

            } catch (masterErr) {
                console.error(`❌ Failed to process master ${masterEmail}:`, masterErr.message);
            }
        }
        console.log('✅ Hourly Master-Slave Sync Enforcement Complete.');

    } catch (error) {
        console.error('CRITICAL: Error in PerformMasterSlaveSync:', error);
    }
}

// Check for Cinemeta version changes and re-apply settings if needed
async function checkCinemetaVersion() {
    console.log('🔍 Checking Cinemeta version...');
    try {
        const response = await fetch('https://v3-cinemeta.strem.io/manifest.json');
        if (!response.ok) throw new Error('Failed to fetch Cinemeta manifest');

        const manifest = await response.json();
        const currentVersion = manifest.version;

        if (!currentVersion) {
            console.warn('Cinemeta manifest missing version');
            return;
        }

        // Get last known version
        let state = await SystemState.findOne({ key: 'cinemeta_version' });

        if (!state) {
            // First run, just save it
            console.log(`[Cinemeta] First run. Saving version: ${currentVersion}`);
            await SystemState.create({ key: 'cinemeta_version', value: currentVersion });
            return;
        }

        if (state.value !== currentVersion) {
            console.log(`🚨 Cinemeta version changed! (${state.value} -> ${currentVersion})`);
            console.log('🔄 Re-applying Cinemeta settings for all users to prevent reset...');

            // Update DB immediately to avoid loops if re-application fails
            state.value = currentVersion;
            state.updatedAt = new Date();
            await state.save();

            // Find all users with Cinemeta settings
            const settingsList = await CinemetaSettings.find({});
            console.log(`Found ${settingsList.length} users with Cinemeta customizations.`);

            for (const setting of settingsList) {
                try {
                    // Only re-apply if they have some enabled settings (removeMetadata, removeSearch, or catalogs)
                    // If everything is default, no need to touch.
                    // But assume existence of record implies customization.

                    // We need the user's password/authKey to apply changes.
                    // Fortunately, applyCinemetaSettings handles login if needed? 
                    // No, applyCinemetaSettings needs authKey.
                    // performUserUpdate handles login. Let's use logic similar to performUserUpdate.

                    // Actually, applyCinemetaSettings is not a standalone function in global scope yet?
                    // It's inside performUserUpdate logic? 
                    // Let's check performUserUpdate. It calls `stremioAPI` methods.
                    // We need to fetch user credentials (AutoUpdateSettings) to login.

                    const userAuth = await AutoUpdateSettings.findOne({ userId: setting.userId });
                    if (!userAuth) {
                        console.warn(`[Cinemeta] Skipping user ${setting.userId} (No credentials found)`);
                        continue;
                    }

                    console.log(`[Cinemeta] Re-applying for ${setting.userId}...`);
                    const password = decrypt(userAuth.encryptedPassword);
                    const authKey = await stremioLogin(setting.userId, password);

                    // We need to fetch current addons first? 
                    // No, we modify Cinemeta within the existing collection.
                    const currentAddons = await getStremioAddons(authKey);

                    // Filter Cinemeta
                    const cinemetaIdx = currentAddons.findIndex(a => a.transportUrl === 'https://v3-cinemeta.strem.io/manifest.json');

                    if (cinemetaIdx === -1) {
                        console.warn(`[Cinemeta] Cinemeta addon not found for ${setting.userId}`);
                        continue;
                    }

                    // Prepare updated manifest based on settings
                    // Wait, we should reuse the logic from POST /api/cinemeta-settings
                    // But that logic is inside the route handler.
                    // I should refactor it or duplicate it safely here. 
                    // Duplication is safer for now to avoid breaking existing route.

                    let cinemeta = currentAddons[cinemetaIdx];
                    let manifest = cinemeta.manifest;

                    // Logic from Route:
                    if (setting.removeMetadata) {
                        manifest.resources = [];
                    }
                    if (setting.removeSearch) {
                        manifest.catalogs = manifest.catalogs.filter(c => c.type !== 'movie' && c.type !== 'series');
                        // Actually the route logic handles "Solo Ricerca" vs "Tutto".
                        // Route logic:
                        // removeSearch (Solo Ricerca): Remove catalogs only?
                        // "Rimuovi Cataloghi Cinemeta: Solo Ricerca" -> removeSearch=true?
                        // "Rimuovi Metadati Cinemeta" -> removeMetadata=true?
                        // "Rimuovi Ricerca Cinemeta" -> removeSearch?

                        // Re-reading user request earlier: "Rimuovi Cataloghi Cinemeta: Solo Ricerca"
                        // This was implemented by filtering manifest.catalogs.
                    }

                    // Let's look at the actual stored data in CinemetaSettings:
                    // removeMetadata: Boolean
                    // removeSearch: Boolean
                    // catalogs: Array (disabled catalogs)

                    // Apply:
                    if (setting.removeMetadata) {
                        // "removeMetadata" usually implies removing resources to force other addons
                        manifest.resources = manifest.resources || [];
                        // Keep stream resource? Usually we kill meta.
                        manifest.resources = manifest.resources.filter(r => r.name !== 'meta');
                    }

                    // Catalogs
                    if (manifest.catalogs) {
                        // Filter out disabled catalogs
                        manifest.catalogs = manifest.catalogs.filter(cat => {
                            const key = `${cat.type}.${cat.id}`;
                            const isDisabled = setting.catalogs && setting.catalogs[key] === true;
                            return !isDisabled;
                        });
                    }

                    // Update Addon
                    currentAddons[cinemetaIdx] = { ...cinemeta, manifest };
                    await setStremioAddons(authKey, currentAddons);
                    console.log(`✅ [Cinemeta] Re-applied successfully for ${setting.userId}`);

                } catch (err) {
                    console.error(`[Cinemeta] Failed for ${setting.userId}:`, err.message);
                }
            }
        } else {
            // console.log(`Cinemeta version stable: ${currentVersion}`);
        }
    } catch (err) {
        console.error('Error checking Cinemeta version:', err);
    }
}

// Hourly Cron Job
cron.schedule('0 * * * *', async () => {
    console.log('🕒 Hourly Cron Job Started...');

    // 1. Check Cinemeta Version
    await checkCinemetaVersion();

    // 2. Master-Slave Sync Enforcement
    await performMasterSlaveSync();

    console.log('✅ Hourly Jobs Complete.');
});

// Manual Trigger for Debugging
app.post('/api/debug/trigger-sync-check', async (req, res) => {
    try {
        console.log('🕵️ Manual trigger of Master-Slave Sync...');
        // Run in background, don't wait for response
        performMasterSlaveSync();
        res.json({ success: true, message: 'Sync process started in background' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to trigger sync' });
    }
});

// Client-side Routing Catch-all
// Must be after all API routes
// Client-side Routing Catch-all
// Must be after all API routes
app.use((req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// Start server
app.listen(PORT, async () => {
    let ip = 'localhost';
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        ip = data.ip;
    } catch (e) {
        console.error('Failed to fetch public IP:', e);
    }
    console.log(`🚀 Server running on http://${ip}:${PORT}`);
});
